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
  /** The session's commands, from the run's control hook. */
  readonly commands: ChannelReader<"control", WorkflowToolRunControlMessage>;
  /**
   * Waits until the control hook is registered, so the session's commands
   * reach the run, and resolves `false` when another run already holds its
   * token. A pending wait keeps the suspension that registers the hook from
   * running its steps inline, so call it only once the run needs the answer.
   */
  register(): Promise<boolean>;
  handleMessage(message: WorkflowToolRunMessage): Promise<void>;
  /**
   * Relays the body's messages to the session in one delivery, which is one
   * durable write: the session gets all of them or none, never a prefix.
   */
  relay(messages: readonly WorkflowToolRunMessage[]): Promise<void>;
}

/** The run's link to its session: commands arrive on its control hook, and its messages go to the session's inbox. */
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
        // A World that can't name the holder rejects instead.
        (error: unknown) => {
          if (isHookConflictError(error)) return false;
          throw error;
        },
      );
      return registered;
    },
    handleMessage,
    relay(messages) {
      // A lone message keeps the shape every session reads.
      if (messages.length === 1) return handleMessage(messages[0]!);
      const batch: WorkflowToolRunMessageBatch = { kind: "workflow-batch", messages };
      return resumeHookStep(input.owner.inbox, batch);
    },
  };
}
