import {
  localSubagentWorkMonitorWorkflowReference,
  startWorkflowPreferLatest,
} from "#execution/workflow-runtime.js";
import type { LocalSubagentWorkMonitorInput } from "#execution/local-subagent-work-monitor-workflow.js";

/** Starts the sibling workflow that polls local child work for channel rendering. */
export async function startLocalSubagentWorkMonitorStep(
  input: LocalSubagentWorkMonitorInput,
): Promise<{ readonly runId: string }> {
  "use step";

  const run = await startWorkflowPreferLatest(localSubagentWorkMonitorWorkflowReference, [input]);
  console.error("[eve.work] started local subagent work monitor", {
    monitorRunId: run.runId,
    parentSessionId: input.sessionState.sessionId,
  });
  return { runId: run.runId };
}
