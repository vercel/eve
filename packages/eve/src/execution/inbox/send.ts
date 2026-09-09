import type { InboxAddress, InboxEnvelope } from "#execution/inbox/types.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { awaitInboxClaim } from "#execution/inbox/startup.js";

export async function sendInbox(
  address: InboxAddress,
  envelope: InboxEnvelope,
  options?: { readonly awaitClaim?: boolean },
): Promise<"delivered" | "gone"> {
  try {
    const send = () =>
      resumeHook(address.token, {
        ...envelope,
        target: { ...envelope.target, ownerRunId: address.ownerRunId },
      });
    const owner = options?.awaitClaim ? await awaitInboxClaim(send) : await send();
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
