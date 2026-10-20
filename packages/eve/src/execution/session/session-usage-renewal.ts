import type { DeliverHookPayload } from "#channel/types.js";
import { renewSessionUsageWindowStep } from "#execution/renew-window-step.js";
import type { DeliveryAdmission, SessionInputQueue } from "#execution/session/input-queue.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { SESSION_LIMIT_CONTINUE_OPTION_ID } from "#harness/hitl/budget-request.js";

/**
 * Applies a renewal that reached this session's inbox, and queues an approval
 * of the session's own prompt when the renewal made it obsolete, so a turn
 * waiting on that prompt goes on. Returns that approval's admission.
 */
export async function applySessionUsageRenewal(
  input: { readonly cursor: SessionStateCursor; readonly queue: SessionInputQueue },
  renewalId: string,
): Promise<DeliveryAdmission | undefined> {
  const { approved } = await input.cursor.advance((state) =>
    renewSessionUsageWindowStep({ ...state, renewalId }),
  );
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
  return input.queue.enqueueDelivery(delivery);
}
