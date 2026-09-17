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

export interface WaitingWorkflowOwner {
  readonly kind: "turn";
  readonly commands: ChannelReader<"control", WorkflowToolRunControlMessage>;
  readonly signal: AbortSignal;
  handleCommand(message: WorkflowToolRunControlMessage): void;
  handleMessage(message: WorkflowToolRunMessage): Promise<void>;
}

/** Routes invocation messages to the waiting turn and accepts cancellation. */
export function createWaitingWorkflowOwner(input: WorkflowToolRunInput): WaitingWorkflowOwner {
  const controller = new AbortController();
  const hook = createHook<WorkflowToolRunControlMessage>({ token: input.hookToken });
  return {
    kind: "turn",
    commands: createChannelReader("control", hook),
    signal: controller.signal,
    handleCommand(message: WorkflowToolRunControlMessage) {
      if (isWorkflowToolRunControlMessage(message))
        controller.abort(new WorkflowToolRunCancelledError(message.reason));
    },
    handleMessage(message: WorkflowToolRunMessage) {
      return resumeHookStep(input.owner.inbox, message, {
        ifPresent: message.kind === "outcome" && message.result.status === "cancelled",
      });
    },
  };
}

class WorkflowToolRunCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkflowToolRunCancelledError";
  }
}
