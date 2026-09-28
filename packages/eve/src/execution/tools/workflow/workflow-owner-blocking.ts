import { createHook } from "#compiled/@workflow/core/index.js";
import {
  createChannelReader,
  type ChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
import type {
  WorkflowToolRunMessage,
  WorkflowToolRunControlMessage,
} from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";

export interface BlockingWorkflowOwner {
  /** The session's commands, from the run's control hook. */
  readonly commands: ChannelReader<"control", WorkflowToolRunControlMessage>;
  handleMessage(message: WorkflowToolRunMessage): Promise<void>;
}

/** The run's link to its session: commands arrive on its control hook, and its messages go to the session's inbox. */
export function createBlockingWorkflow(input: WorkflowToolRunInput): BlockingWorkflowOwner {
  const hook = createHook<WorkflowToolRunControlMessage>({ token: input.hookToken });
  return {
    commands: createChannelReader("control", hook),
    handleMessage(message: WorkflowToolRunMessage) {
      return resumeHookStep(input.owner.inbox, message, {
        ifPresent: message.kind === "outcome" && message.result.status === "cancelled",
      });
    },
  };
}
