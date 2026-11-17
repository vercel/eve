import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import {
  startWorkflowOnCurrentDeployment,
  sessionTimeoutWorkflowReference,
} from "#execution/workflow-runtime.js";
import type { SessionTimeoutWorkflowInput } from "#execution/session/timeout-workflow.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { endStrandedSession } from "#execution/session-inbox/end-stranded-session.js";
import { StrandedSessionOwnerError } from "#execution/session-inbox/owner.js";
import { cancelRun, getWorld } from "#internal/workflow/runtime.js";
import { walkCauseChain } from "#shared/errors.js";

export async function startSessionTimeoutStep(
  input: SessionTimeoutWorkflowInput,
): Promise<{ readonly runId: string }> {
  "use step";

  const run = await startWorkflowOnCurrentDeployment(sessionTimeoutWorkflowReference, [input]);
  return { runId: run.runId };
}

export async function signalSessionTimeoutStep(input: {
  readonly ownerRunId: string;
  readonly token: string;
}): Promise<void> {
  "use step";

  try {
    await resumeSessionInbox(input.token, {
      kind: "session-timeout",
      ownerRunId: input.ownerRunId,
    });
  } catch (error) {
    if (error instanceof StrandedSessionOwnerError) {
      if (error.ownerRunId !== input.ownerRunId) return;
      await endStrandedSession(error, input.token, "timeout");
      return;
    }
    if (!isInactiveTimeoutTarget(error)) {
      throw error;
    }
  }
}

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
