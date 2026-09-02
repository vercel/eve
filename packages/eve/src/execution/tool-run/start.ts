import type { ToolRunWorkflowInput } from "#execution/tool-run/types.js";
import {
  startWorkflowOnCurrentDeployment,
  toolRunWorkflowReference,
  waitForCommandHookOwner,
} from "#execution/workflow-runtime.js";
import { deriveAgentOperationId } from "#harness/handles/operation-id.js";

// Derived from the call alone so a replayed dispatch starts a duplicate that
// loses the claim and still resolves to the run that owns the call.
export function deriveToolRunHookToken(input: {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
}): string {
  return `eve:tool-run:${deriveAgentOperationId(input)}`;
}

/** Resolves once the run owns its hook. Call from inside a `"use step"` body. */
export async function startToolRun(
  input: Omit<ToolRunWorkflowInput, "hookToken">,
): Promise<{ readonly hookToken: string; readonly runId: string }> {
  const hookToken = deriveToolRunHookToken({
    callId: input.callId,
    parentSessionId: input.session.id,
    parentTurnId: input.session.turn.id,
  });
  const workflowInput: ToolRunWorkflowInput = { ...input, hookToken };
  await startWorkflowOnCurrentDeployment(toolRunWorkflowReference, [workflowInput]);
  const owner = await waitForCommandHookOwner(hookToken);
  return { hookToken, runId: owner.runId };
}
