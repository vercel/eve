import { createHook } from "#compiled/@workflow/core/index.js";
import {
  createChannelReader,
  type ChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
import {
  isWorkflowToolRunControlMessage,
  type WorkflowToolRunMessage,
  type WorkflowToolRunControlMessage,
} from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";

export interface BlockingWorkflowOwner {
  readonly commands: ChannelReader<"control", WorkflowToolRunControlMessage>;
  readonly signal: AbortSignal;
  handleCommand(message: WorkflowToolRunControlMessage): void;
  handleMessage(message: WorkflowToolRunMessage): Promise<void>;
}

/** Routes invocation messages to the waiting turn and accepts cancellation. */
export function createBlockingWorkflow(input: WorkflowToolRunInput): BlockingWorkflowOwner {
  const controller = new AbortController();
  const hook = createHook<WorkflowToolRunControlMessage>({ token: input.hookToken });
  let replied = false;
  return {
    commands: createChannelReader("control", hook),
    signal: controller.signal,
    handleCommand(message: WorkflowToolRunControlMessage) {
      if (isWorkflowToolRunControlMessage(message))
        controller.abort(new WorkflowToolRunCancelledError(message.reason));
    },
    handleMessage(message: WorkflowToolRunMessage) {
      // Once the call has its reply, the session may end before the run does.
      const ifPresent =
        replied || (message.kind === "outcome" && message.result.status === "cancelled");
      if (message.kind === "reply") replied = true;
      return resumeHookStep(input.owner.inbox, message, { ifPresent });
    },
  };
}

class WorkflowToolRunCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkflowToolRunCancelledError";
  }
}
