import { disposeHook } from "#execution/hook-ownership.js";
import {
  deriveWorkflowToolRunOwner,
  workflowToolRunHook,
  type WorkflowToolRunMessage,
} from "#execution/tools/workflow/messages.js";
import {
  type ChannelReader,
  createChannelReader,
} from "#execution/tools/workflow/owner-channels.js";

export interface WorkflowToolRunOwnerInbox {
  readonly reader: ChannelReader<"workflow", WorkflowToolRunMessage>;
  dispose(): Promise<void>;
}

export function openWorkflowToolRunOwnerInbox(inboxToken: string): WorkflowToolRunOwnerInbox {
  const owner = deriveWorkflowToolRunOwner(inboxToken);
  const hook = workflowToolRunHook.create({ token: owner.inbox });
  return {
    reader: createChannelReader("workflow", hook),
    dispose: () => disposeHook(hook),
  };
}
