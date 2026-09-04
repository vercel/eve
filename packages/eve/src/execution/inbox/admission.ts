import {
  RunExpiredError,
  WorkflowRunCancelledError,
  WorkflowRunFailedError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";
import { sendInbox } from "#execution/inbox/send.js";
import type { InboxAddress } from "#execution/inbox/types.js";
import { getRun } from "#internal/workflow/runtime.js";

/** The owner awaits readiness delivery, so this marker follows it in the same inbox. */
export async function watchAdmissionOwnerStep(
  ownerRunId: string,
  address: InboxAddress,
): Promise<void> {
  "use step";
  try {
    await getRun(ownerRunId).returnValue;
  } catch (error) {
    if (
      !WorkflowRunFailedError.is(error) &&
      !WorkflowRunCancelledError.is(error) &&
      !WorkflowRunNotFoundError.is(error) &&
      !RunExpiredError.is(error)
    )
      throw error;
  }
  await sendInbox(address, {
    eventId: `${address.ownerRunId}:admission.closed`,
    kind: "admission.closed",
    payload: null,
  });
}
