import type { DeliverHookPayload } from "#channel/types.js";
import type { DeliveryAdmission, SessionInputQueue } from "#execution/session/input-queue.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { applySessionUsageContinuationStep } from "#execution/session-usage-continuation.js";
import { SESSION_LIMIT_CONTINUE_OPTION_ID } from "#harness/hitl/budget-request.js";
import type { SessionUsageGrant } from "#harness/turn-tag-state.js";

/**
 * Applies a grant from above and queues a Continue for the session's own
 * prompts it settled, so a turn parked on one goes on. The answer carries no
 * auth, so it acts as the turn's own identity. Returns its admission.
 */
export async function applySessionUsageContinuation(input: {
  readonly answered?: readonly string[];
  readonly cursor: SessionStateCursor;
  readonly grant: SessionUsageGrant;
  readonly queue: SessionInputQueue;
}): Promise<DeliveryAdmission | undefined> {
  const { approved } = await input.cursor.advance((state) =>
    applySessionUsageContinuationStep({
      ...state,
      answered: input.answered ?? [],
      grant: input.grant,
    }),
  );
  return continueSessionLimitPrompts(input.queue, approved);
}

/**
 * Queues a Continue for the session's own prompts a grant settled. The answer
 * carries no auth, so it acts as the turn's own identity.
 */
export function continueSessionLimitPrompts(
  queue: SessionInputQueue,
  approved: readonly string[],
): DeliveryAdmission | undefined {
  if (approved.length === 0) return undefined;
  const delivery: DeliverHookPayload = {
    kind: "deliver",
    payloads: [
      {
        inputResponses: approved.map((requestId) => ({
          optionId: SESSION_LIMIT_CONTINUE_OPTION_ID,
          requestId,
        })),
      },
    ],
  };
  return queue.enqueueDelivery(delivery);
}
