import type { DeliverPayload } from "#channel/types.js";
import { routeSelectedDelivery } from "#execution/session/route-selected-delivery.js";
import type {
  SessionControl,
  SessionInputQueue,
  TurnSelection,
} from "#execution/session/input-queue.js";
import type { SessionInboxReader } from "#execution/session-inbox/inbox.js";
import { admitSessionInboxPayload } from "#execution/session/admission.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { hasOwnPendingInput } from "#tasks/input.js";
import { applyTaskDeadline, applyTaskReport, cancelTasks } from "#tasks/owner-body.js";

export type NextTurnInstruction =
  | { readonly kind: "workflow"; readonly message: WorkflowToolRunMessage }
  | { readonly kind: "authorization-resume"; readonly payloads: readonly DeliverPayload[] }
  | { readonly kind: SessionControl }
  | { readonly kind: "closed" }
  /** A descendant's declined session-limit prompt stops this session's parked turn. */
  | { readonly kind: "cancel-turn" }
  /** A cancel reached a parked session that still owes its caller a result. */
  | { readonly kind: "cancel-parked" }
  | TurnSelection;

/**
 * Waits for the next input the parked owner must act on. While an
 * authorization challenge is open, its callbacks collect in the queue and
 * resume the challenge once every expected attempt has reported; ordinary
 * deliveries keep starting turns in the meantime. Fully routed descendant
 * deliveries leave nothing for the parent, so the wait continues. Task
 * results never start a turn: each is delivered inside the turn that started
 * its task, which holds until it arrives.
 *
 * No turn runs while parked, so a cancel stops the working tasks it names:
 * every one, or with a `turnId`, only those that turn started, so a cancel
 * sent for an older turn never stops newer work. When `ownsParkedWork` holds,
 * the session still owes its delegated caller a result, such as for a turn
 * parked on an approval, and the owner cancels that work and settles the
 * caller instead.
 */
export async function nextTurnDelivery(input: {
  readonly inbox: SessionInboxReader;
  readonly cursor: SessionStateCursor;
  readonly deferDeliveries?: boolean;
  readonly ownsParkedWork?: () => boolean;
  readonly expectedAttemptIds?: ReadonlySet<string>;
  readonly queue: SessionInputQueue;
}): Promise<NextTurnInstruction> {
  const { inbox, cursor, queue } = input;
  // A delivery admitted while the owner was fully idle (nothing queued, nothing
  // pumped) is the only kind that may move the session to another deployment.
  let freshSequence: number | undefined;
  while (true) {
    const selected = queue.takeNext({
      deferDeliveries: input.deferDeliveries,
      expectedAttemptIds: input.expectedAttemptIds,
      freshSequence: inbox.hasPending() ? undefined : freshSequence,
    });
    if (selected?.kind === "control") return { kind: selected.control };
    if (selected?.kind === "authorization-resume") return selected;
    if (selected?.kind === "turn") {
      const routed = await routeSelectedDelivery(selected, cursor);
      if (routed.kind === "cancel-turn") return routed;
      if (routed.kind === "consumed") continue;
      return routed;
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
    switch (admitted.kind) {
      case "workflow":
        return { kind: "workflow", message: admitted.message };
      case "task-report":
        // A child that reports after its turn ended may still owe it a held cancel.
        await applyTaskReport(cursor, admitted.payload);
        break;
      case "task-deadline":
        // An idle owner still hard-stops children that ignored a cancel.
        await applyTaskDeadline(cursor, admitted.signal);
        break;
      case "runtime-action-result": {
        // Waited results only resolve inside their turn; applying a late one
        // here settles its task record, and a cancelled task drops it.
        const results = admitted.payload.results.filter(
          (result): result is RuntimeSubagentChildResult =>
            result.kind === "subagent-result" && result.origin === "child",
        );
        if (results.length > 0) {
          await applyTaskReport(cursor, {
            kind: "runtime-action-result",
            results,
            source: admitted.payload.source,
          });
        }
        break;
      }
      case "cancel":
        // A reset or expiry also admits as a cancel; the session ends through its control instead.
        if (payload.kind !== "cancel") break;
        if (input.ownsParkedWork?.() === true) return { kind: "cancel-parked" };
        await cancelTasks(
          cursor,
          payload.turnId === undefined ? { kind: "all" } : { kind: "turn", turnId: payload.turnId },
        );
        break;
      case "delivery":
      case "consumed":
        break;
    }
  }
}

// Read raw so the workflow body does not import the harness.
const OPEN_TURN_STATE_KEYS = [
  "eve.runtime.pendingCoordinationBatch",
  "eve.runtime.deferredStepInput",
  "eve.harness.pendingWorkflowInterrupt",
];

/** Whether a turn still waits on answers or actions, even though its stream turn closed. */
export function hasOpenTurnWork(state: Record<string, unknown> | undefined): boolean {
  if (OPEN_TURN_STATE_KEYS.some((key) => state?.[key] !== undefined)) return true;
  return hasOwnPendingInput(state);
}
