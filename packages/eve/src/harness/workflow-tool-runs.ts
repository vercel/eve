import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";

const WORKFLOW_TOOL_RUNS_STATE_KEY = "eve.runtime.workflowToolRuns";

/** A workflow tool run the active turn waits on. Background runs live in the task index. */
export interface WorkflowToolRunRecord {
  readonly callId: string;
  readonly hookToken: string;
  readonly runId: string;
  readonly toolName: string;
  readonly resultKind?: "subagent" | "tool";
}

// Schema-free: this is bundled into the workflow driver.
export function getWorkflowToolRuns(
  state: SessionStateMap | undefined,
): readonly WorkflowToolRunRecord[] {
  const raw = state?.[WORKFLOW_TOOL_RUNS_STATE_KEY];
  return Array.isArray(raw) ? (raw as readonly WorkflowToolRunRecord[]) : [];
}

export function findWorkflowToolRun(
  state: SessionStateMap | undefined,
  callId: string,
): WorkflowToolRunRecord | undefined {
  return getWorkflowToolRuns(state).find((record) => record.callId === callId);
}

export function recordWorkflowToolRun<T extends { readonly state?: SessionStateMap }>(
  session: T,
  record: WorkflowToolRunRecord,
): T {
  const others = getWorkflowToolRuns(session.state).filter(
    (entry) => entry.callId !== record.callId,
  );
  return writeWorkflowToolRuns(session, [...others, record]);
}

export function removeWorkflowToolRun<T extends { readonly state?: SessionStateMap }>(
  session: T,
  callId: string,
): T {
  const records = getWorkflowToolRuns(session.state);
  const remaining = records.filter((entry) => entry.callId !== callId);
  return remaining.length === records.length ? session : writeWorkflowToolRuns(session, remaining);
}

export function clearWorkflowToolRuns(session: HarnessSession): HarnessSession {
  return getWorkflowToolRuns(session.state).length === 0
    ? session
    : writeWorkflowToolRuns(session, []);
}

/** The turn inbox is shared; a result settles a call only if the turn recorded that run. */
export function isInboxToolResultFromRecordedWorkflowToolRun(
  state: SessionStateMap | undefined,
  result: RuntimeToolResultActionResult,
): boolean {
  const record = findWorkflowToolRun(state, result.callId);
  return (
    record !== undefined && record.resultKind !== "subagent" && record.toolName === result.toolName
  );
}

/** A child result reported through a shared subagent execute run. */
export function isInboxSubagentResultFromRecordedWorkflowToolRun(
  state: SessionStateMap | undefined,
  result: { readonly callId: string; readonly subagentName: string },
): boolean {
  const record = findWorkflowToolRun(state, result.callId);
  return record?.resultKind === "subagent" && record.toolName === result.subagentName;
}

function writeWorkflowToolRuns<T extends { readonly state?: SessionStateMap }>(
  session: T,
  records: readonly WorkflowToolRunRecord[],
): T {
  const state = { ...session.state };
  if (records.length === 0) {
    delete state[WORKFLOW_TOOL_RUNS_STATE_KEY];
  } else {
    state[WORKFLOW_TOOL_RUNS_STATE_KEY] = records;
  }
  return { ...session, state: Object.keys(state).length > 0 ? state : undefined };
}
