import type { ToolRunWorkflowInput } from "#execution/tool-run/types.js";
import {
  startWorkflowPreferLatest,
  toolRunWorkflowReference,
  waitForCommandHookOwner,
} from "#execution/workflow-runtime.js";
import { deriveAgentOperationId } from "#harness/handles/operation-id.js";

/**
 * The run's hook token derives from the originating call alone, so a replayed
 * dispatch re-derives it, starts a duplicate that loses the claim, and still
 * resolves to the run that owns the call.
 */
export function deriveToolRunHookToken(input: {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
}): string {
  return `eve:tool-run:${deriveAgentOperationId(input)}`;
}

/**
 * Starts the durable run for one workflow tool call and resolves once that
 * run owns its hook. Call from inside a `"use step"` body.
 */
export async function startToolRun(
  input: Omit<ToolRunWorkflowInput, "hookToken">,
): Promise<{ readonly hookToken: string; readonly runId: string }> {
  const hookToken = deriveToolRunHookToken({
    callId: input.callId,
    parentSessionId: input.session.id,
    parentTurnId: input.session.turn.id,
  });
  const workflowInput: ToolRunWorkflowInput = { ...input, hookToken };
  await startWorkflowPreferLatest(toolRunWorkflowReference, [workflowInput]);
  const owner = await waitForCommandHookOwner(hookToken);
  return { hookToken, runId: owner.runId };
}
