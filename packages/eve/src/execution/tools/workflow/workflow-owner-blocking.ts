import type { RunHost } from "#execution/run-host.js";
import {
  createChannelReader,
  type ChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
import type {
  WorkflowToolRunMessage,
  WorkflowToolRunMessageBatch,
  WorkflowToolRunControlMessage,
} from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";

export interface BlockingWorkflowOwner {
  readonly commands: ChannelReader<"control", WorkflowToolRunControlMessage>;
  register(): Promise<boolean>;
  handleMessage(message: WorkflowToolRunMessage): Promise<void>;
  relay(messages: readonly WorkflowToolRunMessage[]): Promise<void>;
}

export function createBlockingWorkflow(
  input: WorkflowToolRunInput,
  host: RunHost,
): BlockingWorkflowOwner {
  const hook = host.createHook<WorkflowToolRunControlMessage>(input.hookToken);
  let registered: Promise<boolean> | undefined;
  const handleMessage = (message: WorkflowToolRunMessage): Promise<void> =>
    host.resumeHook(input.owner.inbox, message, {
      ifPresent: message.kind === "outcome" && message.result.status === "cancelled",
    });
  return {
    commands: createChannelReader("control", hook),
    register() {
      registered ??= hook.claim();
      return registered;
    },
    handleMessage,
    relay(messages) {
      if (messages.length === 1) return handleMessage(messages[0]!);
      const batch: WorkflowToolRunMessageBatch = { kind: "workflow-batch", messages };
      return host.resumeHook(input.owner.inbox, batch);
    },
  };
}
