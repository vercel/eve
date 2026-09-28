import { createHook } from "#compiled/@workflow/core/index.js";
import type { WorkflowToolRunAsks } from "#execution/tools/workflow/ask.js";
import {
  createChannelReader,
  type ChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
import type {
  WorkflowBodyCommand,
  WorkflowToolRunControlMessage,
  WorkflowToolRunMessage,
} from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";

export interface BlockingWorkflowOwner {
  readonly commands: ChannelReader<"control", WorkflowToolRunControlMessage>;
  /** The call's `interruptSignal`: steering arrived while the turn waits on the call. */
  readonly interruptSignal: AbortSignal;
  readonly signal: AbortSignal;
  handleCommand(command: WorkflowBodyCommand): void;
  handleMessage(message: WorkflowToolRunMessage): Promise<void>;
}

/** Routes invocation messages to the waiting turn and accepts cancellation and interrupts. */
export function createBlockingWorkflow(
  input: WorkflowToolRunInput,
  asks: WorkflowToolRunAsks,
): BlockingWorkflowOwner {
  const controller = new AbortController();
  const interrupt = new AbortController();
  const hook = createHook<WorkflowToolRunControlMessage>({ token: input.hookToken });
  return {
    commands: createChannelReader("control", hook),
    interruptSignal: interrupt.signal,
    signal: controller.signal,
    handleCommand(command: WorkflowBodyCommand) {
      if (command.kind === "interrupt") {
        interrupt.abort();
        return;
      }
      // The session retired the call's questions when it stopped the call,
      // so it accepts no answer after this; settle them before the abort
      // would ask to withdraw them.
      asks.cancelAll();
      controller.abort(new WorkflowToolRunCancelledError(command.reason));
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
