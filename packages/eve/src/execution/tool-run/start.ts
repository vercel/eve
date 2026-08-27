import type { ToolRunWorkflowInput } from "#execution/tool-run/types.js";
import type { RunControlMessage } from "#execution/tool-run/messages.js";
import {
  startWorkflowPreferLatest,
  toolRunWorkflowReference,
  waitForCommandHookOwner,
} from "#execution/workflow-runtime.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { deriveAgentOperationId } from "#harness/handles/operation-id.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";

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
): Promise<{ readonly hookToken: string; readonly ownsRun: boolean; readonly runId: string }> {
  const hookToken = deriveToolRunHookToken({
    callId: input.callId,
    parentSessionId: input.session.id,
    parentTurnId: input.session.turn.id,
  });
  const workflowInput: ToolRunWorkflowInput = { ...input, hookToken };
  const started = await startWorkflowPreferLatest(toolRunWorkflowReference, [workflowInput]);
  const owner = await waitForCommandHookOwner(hookToken);
  return {
    hookToken,
    ownsRun: started?.runId === undefined || owner.runId === started.runId,
    runId: owner.runId,
  };
}

/** Releases a settled subagent relay after its owner durably adopted the run. */
export async function releaseToolRunStep(hookToken: string): Promise<void> {
  "use step";

  const release: RunControlMessage = { kind: "release" };
  try {
    await resumeHook(hookToken, release);
  } catch (error) {
    // A forced cancellation may have disposed the relay before adoption.
    if (!isTaskWorkflowTargetGone(error)) throw error;
  }
}
