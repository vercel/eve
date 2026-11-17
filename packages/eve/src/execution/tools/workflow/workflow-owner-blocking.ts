import { createHook } from "#compiled/@workflow/core/index.js";
import { isHookConflictError } from "#execution/hook-ownership.js";
import {
  createChannelReader,
  type ChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
import type {
  WorkflowToolRunMessage,
  WorkflowToolRunMessageBatch,
  WorkflowToolRunControlMessage,
} from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";

export interface BlockingWorkflowOwner {
  readonly commands: ChannelReader<"control", WorkflowToolRunControlMessage>;
  register(): Promise<boolean>;
  handleMessage(message: WorkflowToolRunMessage): Promise<void>;
  relay(messages: readonly WorkflowToolRunMessage[]): Promise<void>;
}

export function createBlockingWorkflow(input: WorkflowToolRunInput): BlockingWorkflowOwner {
  const hook = createHook<WorkflowToolRunControlMessage>({ token: input.hookToken });
  let registered: Promise<boolean> | undefined;
  const handleMessage = (message: WorkflowToolRunMessage): Promise<void> =>
    resumeHookStep(input.owner.inbox, message, {
      ifPresent: message.kind === "outcome" && message.result.status === "cancelled",
    });
  return {
    commands: createChannelReader("control", hook),
    register() {
      registered ??= hook.getConflict().then(
        (conflict) => conflict === null,
        (error: unknown) => {
          if (isHookConflictError(error)) return false;
          throw error;
        },
      );
      return registered;
    },
    handleMessage,
    relay(messages) {
      if (messages.length === 1) return handleMessage(messages[0]!);
      const batch: WorkflowToolRunMessageBatch = { kind: "workflow-batch", messages };
      return resumeHookStep(input.owner.inbox, batch);
    },
  };
}
