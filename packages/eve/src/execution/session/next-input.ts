import { readDurableSession } from "#execution/durable-session-read.js";
import { activeTurnIdOf, latestTurnIdOf } from "#protocol/session-projection.js";
import { pendingHookSends, pendingPreemptibleSends } from "#reactions/hook-send.js";
import { controlDeliveryOf } from "#execution/session/control-delivery.js";
import type { ControlSettlement } from "#harness/facts.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { openRequests } from "#protocol/session-projection/reader.js";
import { routeSelectedDelivery } from "#execution/session/route-selected-delivery.js";
import type {
  ControlOrigin,
  SessionControl,
  SessionInputQueue,
  TurnSelection,
} from "#execution/session/input-queue.js";
import type { SessionInboxHandle, SessionInboxReader } from "#execution/session-inbox/inbox.js";
import { admitSessionInboxPayload } from "#execution/session/admission.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";

export type NextTurnInstruction =
  | { readonly kind: "prewarm"; readonly targetDeploymentId: string }
  | { readonly kind: "workflow"; readonly message: WorkflowToolRunMessage }
  | { readonly kind: SessionControl; readonly origin?: ControlOrigin }
  | { readonly kind: "closed" }
  | { readonly kind: "cancel-turn"; readonly origin?: ControlOrigin }
  /** `session.cancel()` while no turn runs, but tasks are working. */
  | { readonly kind: "cancel-working-tasks"; readonly origin?: ControlOrigin }
  | TurnSelection;

/**
 * Waits for the next input the parked owner must act on. Fully routed
 * descendant deliveries leave nothing for the parent, so the wait continues.
 */
export async function nextTurnDelivery(input: {
  readonly inbox: SessionInboxReader &
    Pick<SessionInboxHandle, "awaitingHandover" | "whenHandoverSettled">;
  readonly cursor: SessionStateCursor;
  readonly hasWorkingTasks: () => boolean;
  readonly queue: SessionInputQueue;
  /** Settles a control that changes nothing; a session that hasn't started defers it. */
  readonly ignore: (settlement: ControlSettlement) => Promise<void>;
}): Promise<NextTurnInstruction> {
  const { inbox, cursor, queue } = input;
  // A delivery admitted while the owner was fully idle (nothing queued, nothing
  // pumped) is the only kind that may move the session to another deployment.
  let freshSequence: number | undefined;
  while (true) {
    // Hooks' steer and queue messages are input like a person's; their keys admit each once.
    for (const delivery of pendingHookSends(cursor.serializedContext))
      queue.enqueueDelivery(delivery);
    const selected = queue.takeNext({
      freshSequence: inbox.hasPending() ? undefined : freshSequence,
    });
    if (selected?.kind === "control") {
      // Hooks' messages sent after a clear or reset was queued still wait behind it; it drops them.
      if (selected.control === "clear" || selected.control === "reset") queue.dropHookDeliveries();
      return selected.origin === undefined
        ? { kind: selected.control }
        : { kind: selected.control, origin: selected.origin };
    }
    if (selected?.kind === "turn") {
      const routed = await routeSelectedDelivery(selected, cursor);
      if (routed.kind === "cancel-turn") return routed;
      if (routed.kind === "consumed") continue;
      return routed;
    }

    // A hook's preemptible message starts the next turn only once nothing else waits; input that
    // starts another turn first discards it. Its idempotency key admits it once.
    if (queue.pendingCount === 0 && !inbox.hasPending()) {
      const preemptible = pendingPreemptibleSends(
        cursor.serializedContext,
        latestTurnIdOf(storedProjection(readDurableSession(cursor.sessionState).state)),
      );
      if (preemptible.length > 0) {
        // Behind an awaited handover, older input is queued but unreadable: wait for it, so the
        // message gives way to it as it would to anything readable.
        if (inbox.awaitingHandover) {
          await inbox.whenHandoverSettled();
          continue;
        }
        let admitted = false;
        for (const delivery of preemptible) {
          if (queue.enqueueDelivery(delivery) !== undefined) admitted = true;
        }
        if (admitted) continue;
      }
    }

    if (!inbox.hasPending()) {
      const targetDeploymentId = queue.takePrewarmDeployment();
      if (targetDeploymentId !== undefined) return { kind: "prewarm", targetDeploymentId };
    }

    // A delivery may already be in the pump queue by the time the owner exits
    // its committed waiting step. It is still an idle arrival when no earlier
    // input was admitted; the post-read `hasPending()` check below rejects a
    // burst with later buffered input.
    const wasIdle = queue.pendingCount === 0;
    const payload = await inbox.next();
    if (payload === undefined) return { kind: "closed" };

    const admitted = await admitSessionInboxPayload(payload, input);
    freshSequence =
      wasIdle && admitted.kind === "delivery" ? admitted.admission.sequence : undefined;
    if (admitted.kind === "workflow") return { kind: "workflow", message: admitted.message };
    if (admitted.kind !== "cancel") continue;
    const projection = storedProjection(readDurableSession(cursor.sessionState).state);
    const view = projection.view;
    const stale =
      payload.kind === "cancel" &&
      payload.turnId !== undefined &&
      payload.turnId !== activeTurnIdOf(projection);
    if (!stale && openRequests(view).some((row) => row.request.kind === "budget")) {
      return { kind: "cancel-turn", origin: admitted.origin };
    }
    if (!stale && input.hasWorkingTasks()) {
      return { kind: "cancel-working-tasks", origin: admitted.origin };
    }
    if (admitted.origin !== undefined)
      await input.ignore({
        control: controlDeliveryOf(admitted.origin),
        outcome: "ignored",
        source: "cancel",
      });
  }
}
