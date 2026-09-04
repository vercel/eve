import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import { dispatchSessionCommandByToken } from "#execution/session/ingress.js";
import { startWorkflowOnCurrentDeployment } from "#execution/workflow-start.js";
import { sessionTimeoutWorkflowReference } from "#execution/workflow-references.js";
import type { SessionTimeoutWorkflowInput } from "#execution/session-timeout-workflow.js";
import { cancelRun, getWorld } from "#internal/workflow/runtime.js";
import { walkCauseChain } from "#shared/errors.js";

/** Starts the durable timer that signals one session deadline. */
export async function startSessionTimeout(
  input: SessionTimeoutWorkflowInput,
): Promise<{ readonly runId: string }> {
  const run = await startWorkflowOnCurrentDeployment(sessionTimeoutWorkflowReference, [input]);
  return { runId: run.runId };
}

/** Admits expiry through an independent turn when the durable timer elapses. */
export async function signalSessionTimeoutStep(input: { readonly token: string }): Promise<void> {
  "use step";

  try {
    await dispatchSessionCommandByToken(
      input.token,
      { kind: "session-timeout" },
      `expiry:${input.token}`,
    );
  } catch (error) {
    if (!isInactiveTimeoutTarget(error)) {
      throw error;
    }
  }
}

/** Cancels a timer whose session reached another terminal outcome first. */
export async function cancelSessionTimeout(input: { readonly runId: string }): Promise<void> {
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
