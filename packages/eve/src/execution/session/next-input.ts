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
import { applyTaskReport } from "#tasks/owner-body.js";

export type NextTurnInstruction =
  | { readonly kind: "workflow"; readonly message: WorkflowToolRunMessage }
  | { readonly kind: "authorization-resume"; readonly payloads: readonly DeliverPayload[] }
  | { readonly kind: SessionControl }
  | { readonly kind: "closed" }
  | { readonly kind: "cancel-turn" }
  | TurnSelection;

/**
 * Waits for the next input the parked owner must act on. While an
 * authorization challenge is open, its callbacks collect in the queue and
 * resume the challenge once every expected attempt has reported; ordinary
 * deliveries keep starting turns in the meantime. Fully routed descendant
 * deliveries leave nothing for the parent, so the wait continues.
 */
export async function nextTurnDelivery(input: {
  readonly inbox: SessionInboxReader;
  readonly cursor: SessionStateCursor;
  readonly deferDeliveries?: boolean;
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
      case "delivery":
      case "consumed":
        break;
    }
  }
}
