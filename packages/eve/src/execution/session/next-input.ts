import { forwardRelayedAnswers } from "#harness/human-input/effects/workflow.js";
import type {
  SessionControl,
  SessionInputQueue,
  TurnSelection,
} from "#execution/session/input-queue.js";
import type { SessionInboxReader } from "#execution/session-inbox/inbox.js";
import { admitSessionInboxPayload } from "#execution/session/admission.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";

export type NextTurnInstruction =
  | { readonly kind: "workflow"; readonly message: WorkflowToolRunMessage }
  | { readonly kind: SessionControl }
  | { readonly kind: "closed" }
  /** A relayed budget Stop: the open turn, if any, is cancelled. */
  | { readonly kind: "cancel-turn" }
  /** `session.cancel()` while no turn runs, but tasks are working. */
  | { readonly kind: "cancel-working-tasks" }
  | TurnSelection;

/**
 * Waits for the next input the parked owner must act on. A delivery that only
 * answers relayed requests leaves nothing for the session, so the wait
 * continues.
 */
export async function nextTurnDelivery(input: {
  readonly cursor: SessionStateCursor;
  readonly inbox: SessionInboxReader;
  readonly hasWorkingTasks: () => boolean;
  readonly queue: SessionInputQueue;
}): Promise<NextTurnInstruction> {
  const { inbox, queue } = input;
  // A delivery admitted while the owner was fully idle (nothing queued, nothing
  // pumped) is the only kind that may move the session to another deployment.
  let freshSequence: number | undefined;
  while (true) {
    const selected = queue.takeNext({
      freshSequence: inbox.hasPending() ? undefined : freshSequence,
    });
    if (selected?.kind === "control") return { kind: selected.control };
    if (selected?.kind === "turn") {
      const forwarded = await forwardRelayedAnswers(selected.delivery, input.cursor);
      if (forwarded.kind === "cancel-turn") return forwarded;
      if (forwarded.remainder === undefined) continue;
      return { ...selected, delivery: forwarded.remainder };
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
    if (admitted.kind === "cancel" && input.hasWorkingTasks()) {
      return { kind: "cancel-working-tasks" };
    }
  }
}
