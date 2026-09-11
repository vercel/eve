import { createHook } from "#compiled/@workflow/core/index.js";
import type {
  WorkflowToolRunMessage,
  WorkflowToolRunOwner,
} from "#execution/tools/workflow/messages.js";
import {
  createChannelReader,
  type ChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
import { disposeHook } from "#execution/hook-ownership.js";

export interface WorkflowToolRunOwnerInbox {
  dispose(): Promise<void>;
  readonly owner: WorkflowToolRunOwner;
  readonly reader: ChannelReader<"workflow", WorkflowToolRunMessage>;
}

/** Background task workflows have their own lifecycle, outside a session inbox. */
export function openWorkflowToolRunOwnerInbox(): WorkflowToolRunOwnerInbox {
  const hook = createHook<WorkflowToolRunMessage>();
  return {
    dispose: () => disposeHook(hook),
    owner: { inbox: hook.token },
    reader: createChannelReader("workflow", hook),
  };
}
