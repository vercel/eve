/**
 * Opts eve sessions into Workflow storing `workflow/state` values by reference
 * (see `withSessionStateDelta`). Workflow reads the setting where it writes
 * payloads; an explicit operator value wins, so `WORKFLOW_STATE_REFS=0` opts out.
 */
export function installWorkflowStateRefs(): void {
  process.env.WORKFLOW_STATE_REFS ??= "1";
}

/** Whether session steps return `produce()` results instead of structural deltas. */
export function workflowStateRefsEnabled(): boolean {
  return process.env.WORKFLOW_STATE_REFS === "1";
}
