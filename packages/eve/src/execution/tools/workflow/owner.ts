import { createHook } from "#compiled/@workflow/core/index.js";
import type {
  WorkflowToolRunMessage,
  WorkflowToolRunRequestMessage,
  WorkflowToolAuthorizationRequest,
  WorkflowToolRunOwner,
} from "#execution/tools/workflow/messages.js";
import {
  createChannelReader,
  type ChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { disposeHook } from "#execution/hook-ownership.js";

export interface WorkflowToolRunOwnerInbox {
  dispose(): Promise<void>;
  readonly owner: WorkflowToolRunOwner;
  readonly reader: ChannelReader<"workflow", WorkflowToolRunMessage>;
}

/** Receives body messages before routing them to the turn or session owner. */
export function openWorkflowToolRunOwnerInbox(): WorkflowToolRunOwnerInbox {
  const hook = createHook<WorkflowToolRunMessage>();
  return {
    dispose: () => disposeHook(hook),
    owner: { inbox: hook.token },
    reader: createChannelReader("workflow", hook),
  };
}

/** Acknowledge only step-owned events, after delivery or deliberate discard. */
export async function deliverWorkflowAuthorization(
  message: WorkflowToolRunRequestMessage & { readonly request: WorkflowToolAuthorizationRequest },
  deliver: () => Promise<void>,
): Promise<void> {
  await deliver();
  // Agent events reuse their invocation reply channel; it is not an event acknowledgement.
  if (message.request.event.childSessionId === message.from.runId)
    await resumeHookStep(message.replyTo, null, { ifPresent: true });
}
