import {
  workflowToolRunHook,
  type WorkflowToolRunMessage,
  type WorkflowToolRunOwner,
} from "#execution/tools/workflow/messages.js";
import {
  type ChannelReader,
  createChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
import { disposeHook } from "#execution/hook-ownership.js";

export interface WorkflowToolRunOwnerInbox {
  dispose(): Promise<void>;
  readonly owner: WorkflowToolRunOwner;
  readonly reader: ChannelReader<"workflow", WorkflowToolRunMessage>;
}

export function openWorkflowToolRunOwnerInbox(): WorkflowToolRunOwnerInbox {
  const hook = workflowToolRunHook.create();
  return {
    dispose: async () => await disposeHook(hook),
    owner: { inbox: hook.token },
    reader: createChannelReader("workflow", hook),
  };
}
