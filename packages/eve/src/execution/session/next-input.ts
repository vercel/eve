import { readDurableSession } from "#execution/durable-session-read.js";
import { activeTurnIdOf, latestTurnIdOf } from "#protocol/session-projection.js";
import { pendingContinuation, pendingSessionEnd } from "#definitions/continuation.js";
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
import {
  isDeliveryPayload,
  type SessionInboxHandle,
  type SessionInboxReader,
} from "#execution/session-inbox/inbox.js";
import { admitSessionInboxPayload } from "#execution/session/admission.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";

export type NextTurnInstruction =
  | { readonly kind: "prewarm"; readonly targetDeploymentId: string }
  | { readonly kind: "workflow"; readonly message: WorkflowToolRunMessage }
  | { readonly kind: SessionControl; readonly origin?: ControlOrigin }
  | { readonly kind: "end"; readonly hook: string }
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
  readonly whileWaiting?: () => Promise<void>;
  readonly hold?: { readonly ms: number; readonly until: (at: number) => Promise<void> };
}): Promise<NextTurnInstruction> {
  const { inbox, cursor, queue, hold } = input;
  const holdAfter = (admitted: Awaited<ReturnType<typeof admitSessionInboxPayload>>): void => {
    if (hold === undefined || hold.ms <= 0 || admitted.kind !== "delivery") return;
    const { delivery } = admitted.admission;
    if (delivery.turnPolicy === "queue" && delivery.caller === undefined) {
      queue.beginHold(Date.now() + hold.ms);
    }
  };
  let freshSequence: number | undefined;
  while (true) {
    const end = pendingSessionEnd(cursor.serializedContext);
    if (end !== undefined) return { kind: "end", ...end };

    for (const payload of inbox.takeLeading(isDeliveryPayload)) {
      const idle = queue.pendingCount === 0;
      const admitted = await admitSessionInboxPayload(payload, input);
      if (!idle) continue;
      if (freshSequence === undefined && admitted.kind === "delivery") {
        freshSequence = admitted.admission.sequence;
      }
      holdAfter(admitted);
    }
    const holding = hold === undefined ? undefined : queue.activeHold();
    if (hold !== undefined && holding !== undefined) {
      holding.timer ??= hold.until(holding.at);
      const elapsed = await Promise.race([
        inbox.whenPending().then(() => false),
        holding.timer.then(() => true),
      ]);
      if (elapsed) {
        queue.endHold();
        continue;
      }
    }
    const selected =
      holding === undefined
        ? queue.takeNext({ freshSequence: inbox.hasPending() ? undefined : freshSequence })
        : undefined;
    if (selected?.kind === "control")
      return selected.origin === undefined
        ? { kind: selected.control }
        : { kind: selected.control, origin: selected.origin };
    if (selected?.kind === "turn") {
      const routed = await routeSelectedDelivery(selected, cursor);
      const endAfterRoute = pendingSessionEnd(cursor.serializedContext);
      if (endAfterRoute !== undefined) return { kind: "end", ...endAfterRoute };
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

    if (!inbox.hasPending()) await input.whileWaiting?.();
    const wasIdle = queue.pendingCount === 0;
    const payload = await inbox.next();
    if (payload === undefined) return { kind: "closed" };

    const admitted = await admitSessionInboxPayload(payload, input);
    freshSequence =
      wasIdle && admitted.kind === "delivery" ? admitted.admission.sequence : undefined;
    if (wasIdle) holdAfter(admitted);
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
