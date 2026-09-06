import {
  getStepMetadata,
  getWorkflowMetadata,
  getWritable,
} from "#compiled/@workflow/core/index.js";
import { consumeAuthorizationResult, getAuthorizationResults } from "#harness/authorization.js";
import { getRun } from "#internal/workflow/runtime.js";
import {
  completeScopedAuthorization,
  type ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";

/** Record successful completion before returning to authored code. */
export async function completeWorkflowStepAuthorization(
  scoped: ScopedAuthorization,
): Promise<boolean> {
  const result = getAuthorizationResults().find(
    (result) => result.name === scoped.scope && result.instanceId === scoped.instanceId,
  );
  if (result === undefined) return false;

  const { stepId, attempt } = getStepMetadata();
  const namespace = `eve.authorization.${stepId}.${result.attemptId}`;
  if (attempt > 1) {
    const stream = getRun(getWorkflowMetadata().workflowRunId).getReadable({ namespace });
    try {
      if ((await stream.getTailIndex()) >= 0) {
        consumeAuthorizationResult(scoped.scope, scoped.instanceId);
        // The shared execution resolves the token through the provider's store and retains
        // its fresh-token rejection guard. No bearer is stored in this completion stream.
        return true;
      }
    } finally {
      await stream.cancel().catch(() => {});
    }
  }

  if (!(await completeScopedAuthorization(scoped))) return false;
  const writer = getWritable<true>({ namespace }).getWriter();
  try {
    await writer.write(true);
  } finally {
    writer.releaseLock();
  }
  return true;
}
