import type { BackgroundWorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import {
  startWorkflowOnCurrentDeployment,
  workflowToolRunWorkflowReference,
  waitForCommandHookOwner,
} from "#execution/workflow-runtime.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import {
  type TaskCommand,
  type TaskCommandHookPayload,
  type TaskRunInboundPayload,
} from "#tasks/types.js";

/**
 * Node-side admission and cancellation for session-owned workflow invocations.
 *
 * Every export must be called from inside a `"use step"` body; none of
 * these are steps themselves so dispatch and tool steps can compose them
 * inside one durable boundary.
 */

/** Starts a session-owned invocation through the common workflow entry. */
export async function startTaskRun(input: BackgroundWorkflowToolRunInput): Promise<void> {
  await startWorkflowOnCurrentDeployment(workflowToolRunWorkflowReference, [input]);
}

/** Resolves the task run that won ownership of one replay-stable command token. */
export async function waitForTaskCommandOwner(input: {
  readonly taskInboxToken: string;
}): Promise<{ readonly runId: string }> {
  return await waitForCommandHookOwner(input.taskInboxToken);
}

/**
 * Submits one command to a task run.
 *
 * `unreachable` means the hook is not resumable — either the run
 * already finished and disposed it (the task is terminal; read the
 * final view) or, right after creation, the freshly started run has
 * not registered it yet. Senders racing that startup window pass
 * `retryUnreachable`; senders addressing an established task treat
 * `unreachable` as the terminal signal.
 */
export async function sendTaskCommand(input: {
  readonly command: TaskCommand;
  readonly taskInboxToken: string;
  readonly retryUnreachable?: { readonly attempts: number; readonly delayMs: number };
}): Promise<"delivered" | "unreachable"> {
  return (await sendTaskCommandToOwner(input)) === undefined ? "unreachable" : "delivered";
}

/** Delivers one command and returns the accepting task workflow's run id. */
export async function sendTaskCommandToOwner(input: {
  readonly command: TaskCommand;
  readonly taskInboxToken: string;
  readonly retryUnreachable?: { readonly attempts: number; readonly delayMs: number };
}): Promise<{ readonly runId: string } | undefined> {
  const payload: TaskCommandHookPayload = { command: input.command, kind: "task-command" };
  const attempts = Math.max(1, input.retryUnreachable?.attempts ?? 1);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const owner = await resumeHook(input.taskInboxToken, payload);
      if (
        typeof owner !== "object" ||
        owner === null ||
        !("runId" in owner) ||
        typeof owner.runId !== "string"
      ) {
        throw new Error(`Task inbox hook "${input.taskInboxToken}" returned no owner run id.`);
      }
      return { runId: owner.runId };
    } catch (error) {
      if (!isTaskWorkflowTargetGone(error)) {
        throw error;
      }
      if (attempt + 1 >= attempts) {
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, input.retryUnreachable?.delayMs ?? 250));
    }
  }
}

/**
 * Hands one non-command inbound payload to a task run.
 *
 * Used for payloads the run must act on before it may record them —
 * today only answered input batches, which it forwards to the child
 * first. `unreachable` means the task already finished and disposed its
 * hook, so the payload is stale by definition.
 */
export async function sendTaskInboundPayload(input: {
  readonly taskInboxToken: string;
  readonly payload: TaskRunInboundPayload;
}): Promise<"delivered" | "unreachable"> {
  try {
    await resumeHook(input.taskInboxToken, input.payload);
    return "delivered";
  } catch (error) {
    if (!isTaskWorkflowTargetGone(error)) {
      throw error;
    }
    return "unreachable";
  }
}
