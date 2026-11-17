import { readDurableSession } from "#execution/durable-session-read.js";
import { activeTurnIdOf, latestTurnIdOf } from "#protocol/session-projection.js";
import { pendingContinuation } from "#definitions/continuation.js";
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
  | { readonly kind: "cancel-working-tasks"; readonly origin?: ControlOrigin }
  | TurnSelection;

export async function nextTurnDelivery(input: {
  readonly inbox: SessionInboxReader &
    Pick<SessionInboxHandle, "awaitingHandover" | "whenHandoverSettled">;
  readonly cursor: SessionStateCursor;
  readonly hasWorkingTasks: () => boolean;
  readonly queue: SessionInputQueue;
  readonly ignore: (settlement: ControlSettlement) => Promise<void>;
}): Promise<NextTurnInstruction> {
  const { inbox, cursor, queue } = input;
  let freshSequence: number | undefined;
  while (true) {
    const selected = queue.takeNext({
      freshSequence: inbox.hasPending() ? undefined : freshSequence,
    });
    if (selected?.kind === "control")
      return selected.origin === undefined
        ? { kind: selected.control }
        : { kind: selected.control, origin: selected.origin };
    if (selected?.kind === "turn") {
      const routed = await routeSelectedDelivery(selected, cursor);
      if (routed.kind === "cancel-turn") return routed;
      if (routed.kind === "consumed") continue;
      return routed;
    }

    if (queue.pendingCount === 0 && !inbox.hasPending()) {
      const continuation = pendingContinuation(
        cursor.serializedContext,
        latestTurnIdOf(storedProjection(readDurableSession(cursor.sessionState).state)),
      );
      if (continuation !== undefined) {
        if (inbox.awaitingHandover) {
          await inbox.whenHandoverSettled();
          continue;
        }
        if (queue.enqueueDelivery(continuation) !== undefined) continue;
      }
    }

    if (!inbox.hasPending()) {
      const targetDeploymentId = queue.takePrewarmDeployment();
      if (targetDeploymentId !== undefined) return { kind: "prewarm", targetDeploymentId };
    }

    const wasIdle = queue.pendingCount === 0;
    const payload = await inbox.next();
    if (payload === undefined) return { kind: "closed" };

    const admitted = await admitSessionInboxPayload(payload, input);
    freshSequence =
      wasIdle && admitted.kind === "delivery" ? admitted.admission.sequence : undefined;
    if (admitted.kind === "workflow") return { kind: "workflow", message: admitted.message };
    if (admitted.kind === "unsupported") {
      await input.ignore(admitted.settlement);
      continue;
    }
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
