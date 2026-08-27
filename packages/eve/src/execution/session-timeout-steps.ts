import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import {
  startWorkflowPreferLatest,
  sessionTimeoutWorkflowReference,
} from "#execution/workflow-runtime.js";
import {
  createSessionTimeoutWorkflowInput,
  type SessionTimeoutWorkflowDispatchInput,
} from "#execution/durable-session-migrations/session-timeout-workflow.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import { cancelRun, getWorld } from "#internal/workflow/runtime.js";
import { walkCauseChain } from "#shared/errors.js";

/** Starts the durable timer that signals one session deadline. */
export async function startSessionTimeoutStep(
  input: SessionTimeoutWorkflowDispatchInput,
): Promise<{ readonly runId: string }> {
  "use step";

  const run = await startWorkflowPreferLatest(sessionTimeoutWorkflowReference, [
    createSessionTimeoutWorkflowInput(input),
  ]);
  return { runId: run.runId };
}

/** Resumes the owning driver when its durable timer elapses. */
export async function signalSessionTimeoutStep(input: { readonly token: string }): Promise<void> {
  "use step";

  try {
    await resumeSessionInbox(input.token, { kind: "session-timeout" });
  } catch (error) {
    if (!isInactiveTimeoutTarget(error)) {
      throw error;
    }
  }
}

/** Cancels a timer whose session reached another terminal outcome first. */
export async function cancelSessionTimeoutStep(input: { readonly runId: string }): Promise<void> {
  "use step";

  try {
    await cancelRun(await getWorld(), input.runId, {
      cancelReason: "Session ended before its timeout",
    });
  } catch (error) {
    if (!isInactiveTimeoutTarget(error)) {
      throw error;
    }
  }
}

function isInactiveTimeoutTarget(error: unknown): boolean {
  for (const candidate of walkCauseChain(error)) {
    if (
      HookNotFoundError.is(candidate) ||
      WorkflowRunNotFoundError.is(candidate) ||
      RunExpiredError.is(candidate) ||
      EntityConflictError.is(candidate)
    ) {
      return true;
    }
  }
  return false;
}
