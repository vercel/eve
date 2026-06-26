import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
import { dispatchWorkflowRuntimeActionsStep } from "#execution/dispatch-workflow-runtime-actions-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";

/** Dispatches one model- or Workflow-originated child-agent batch for an active turn. */
export async function dispatchTurnRuntimeActionsStep(input: {
  readonly parentContinuationToken: string;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly workflowInterrupt: boolean;
}): Promise<{
  readonly results: readonly RuntimeSubagentResultActionResult[];
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  const dispatch = input.workflowInterrupt
    ? dispatchWorkflowRuntimeActionsStep
    : dispatchRuntimeActionsStep;
  return dispatch({
    callbackBaseUrl: resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url),
    parentContinuationToken: input.parentContinuationToken,
    parentWritable: input.parentWritable,
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
}
