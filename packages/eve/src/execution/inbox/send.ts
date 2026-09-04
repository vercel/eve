import type { InboxAddress, InboxEnvelope } from "#execution/inbox/types.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { resumeHook } from "#internal/workflow/runtime.js";

export async function sendInbox(
  address: InboxAddress,
  envelope: InboxEnvelope,
): Promise<"delivered" | "gone"> {
  try {
    const owner = await resumeHook(address.token, {
      ...envelope,
      target: { ...envelope.target, ownerRunId: address.ownerRunId },
    });
    return owner.runId === address.ownerRunId ? "delivered" : "gone";
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) return "gone";
    throw error;
  }
}

export async function sendInboxStep(
  address: InboxAddress,
  envelope: InboxEnvelope,
): Promise<"delivered" | "gone"> {
  "use step";
  return await sendInbox(address, envelope);
}
