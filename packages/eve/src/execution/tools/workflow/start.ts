import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import {
  startWorkflowPreferLatest,
  workflowToolRunWorkflowReference,
  waitForCommandHookOwner,
} from "#execution/workflow-runtime.js";
import { deriveAgentOperationId } from "#subagents/handles/operation-id.js";

// Derived from the call alone so a replayed dispatch starts a duplicate that
// loses the claim and still resolves to the workflow tool run that owns the call.
export function deriveWorkflowToolRunHookToken(input: {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
}): string {
  return `eve:workflow-tool-run:${deriveAgentOperationId(input)}`;
}

/** Resolves once the workflow tool run owns its hook. Call from a `"use step"` body. */
export async function startWorkflowToolRun(
  input: Omit<WorkflowToolRunInput, "hookToken"> & { readonly hookToken?: string },
): Promise<{ readonly hookToken: string; readonly runId: string }> {
  const hookToken =
    input.hookToken ??
    deriveWorkflowToolRunHookToken({
      callId: input.callId,
      parentSessionId: input.session.id,
      parentTurnId: input.session.turn.id,
    });
  const workflowToolRunInput = { ...input, hookToken } as WorkflowToolRunInput;
  await startWorkflowPreferLatest(workflowToolRunWorkflowReference, [workflowToolRunInput]);
  const owner = await waitForCommandHookOwner(hookToken);
  return { hookToken, runId: owner.runId };
}
