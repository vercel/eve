import { createHook } from "#compiled/@workflow/core/index.js";
import { claimHookOwnership, isHookConflictError } from "#execution/hook-ownership.js";
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
  /**
   * Claims the task's command hook. `false` means another run of the same
   * task holds it: this run is a duplicate start and must exit without
   * running the body or reporting.
   */
  claim(): Promise<boolean>;
  handleCommand(message: WorkflowToolRunControlMessage): void;
  /**
   * Sends a message to the owner session. Returns `false` when the owner of an
   * outcome is gone: the owner hands off only while no task is working, so an
   * outcome it still waits for always finds it, and a missing inbox means its
   * session ended. An outcome for a task the owner already stopped only
   * confirms the stop, which the owner's timer enforces without it.
   */
  handleMessage(message: WorkflowToolRunMessage): Promise<boolean>;
}

/** Routes invocation messages to the owner and accepts its commands; only a cancel aborts the run. */
export function createBlockingWorkflow(input: WorkflowToolRunInput): BlockingWorkflowOwner {
  const controller = new AbortController();
  const hook = createHook<WorkflowToolRunControlMessage>({ token: input.hookToken });
  return {
    commands: createChannelReader("control", hook),
    signal: controller.signal,
    async claim() {
      try {
        await claimHookOwnership(hook);
        return true;
      } catch (error) {
        if (isHookConflictError(error)) return false;
        throw error;
      }
    },
    handleCommand(message: WorkflowToolRunControlMessage) {
      if (isWorkflowToolRunControlMessage(message) && message.kind === "cancel")
        controller.abort(new WorkflowToolRunCancelledError(message.reason));
    },
    handleMessage(message: WorkflowToolRunMessage) {
      // A lifecycle message for an owner that ended has no taker.
      return resumeHookStep(input.owner.inbox, message, {
        ifPresent: message.kind !== "report" && message.kind !== "request",
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
