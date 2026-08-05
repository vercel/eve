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
import type { SessionTimeoutWorkflowInput } from "#execution/session-timeout-workflow.js";
import { cancelRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { walkCauseChain } from "#shared/errors.js";

/** Starts the durable timer that signals one session deadline. */
export async function startSessionTimeoutStep(
  input: SessionTimeoutWorkflowInput,
): Promise<{ readonly runId: string }> {
  "use step";

  const run = await startWorkflowPreferLatest(sessionTimeoutWorkflowReference, [input]);
  return { runId: run.runId };
}

/** Resumes the owning driver when its durable timer elapses. */
export async function signalSessionTimeoutStep(input: {
  readonly kind?: "approval-candidate-expiry" | "session-timeout";
  readonly token: string;
}): Promise<void> {
  "use step";

  try {
    await resumeHook(input.token, { kind: input.kind ?? "session-timeout" });
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
