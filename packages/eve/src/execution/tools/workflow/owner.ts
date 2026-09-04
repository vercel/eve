import {
  workflowToolRunHook,
  type WorkflowToolRunMessage,
  type WorkflowToolRunOwner,
} from "#execution/tools/workflow/messages.js";
import {
  type ChannelReader,
  createChannelReader,
} from "#execution/tools/workflow/owner-channels.js";

export interface WorkflowToolRunOwnerInbox {
  readonly owner: WorkflowToolRunOwner;
  readonly reader: ChannelReader<"workflow", WorkflowToolRunMessage>;
}

export function openWorkflowToolRunOwnerInbox(): WorkflowToolRunOwnerInbox {
  const hook = workflowToolRunHook.create();
  return {
    owner: { inbox: hook.token },
    reader: createChannelReader("workflow", hook),
  };
}
