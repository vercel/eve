import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";

const TOOL_RUNS_STATE_KEY = "eve.runtime.toolRuns";
export function toolRunAnswerToken(runId: string, seq: number): string {
  return `eve:tool-run-answer:${runId}:${seq}`;
}

/** A workflow tool run the active turn waits on. Background runs live in the task index. */
export interface ToolRunRecord {
  readonly callId: string;
  readonly hookToken: string;
  readonly runId: string;
  readonly toolName: string;
}

// Schema-free: this is bundled into the workflow driver.
export function getToolRuns(state: SessionStateMap | undefined): readonly ToolRunRecord[] {
  const raw = state?.[TOOL_RUNS_STATE_KEY];
  return Array.isArray(raw) ? (raw as readonly ToolRunRecord[]) : [];
}

export function findToolRun(
  state: SessionStateMap | undefined,
  callId: string,
): ToolRunRecord | undefined {
  return getToolRuns(state).find((record) => record.callId === callId);
}

export function recordToolRun<T extends { readonly state?: SessionStateMap }>(
  session: T,
  record: ToolRunRecord,
): T {
  const others = getToolRuns(session.state).filter((entry) => entry.callId !== record.callId);
  return writeToolRuns(session, [...others, record]);
}

export function removeToolRun<T extends { readonly state?: SessionStateMap }>(
  session: T,
  callId: string,
): T {
  const records = getToolRuns(session.state);
  const remaining = records.filter((entry) => entry.callId !== callId);
  return remaining.length === records.length ? session : writeToolRuns(session, remaining);
}

export function clearToolRuns(session: HarnessSession): HarnessSession {
  return getToolRuns(session.state).length === 0 ? session : writeToolRuns(session, []);
}

/** The turn inbox is shared; a result settles a call only if the turn recorded that run. */
export function isInboxToolResultFromRecordedRun(
  state: SessionStateMap | undefined,
  result: RuntimeToolResultActionResult,
): boolean {
  const record = findToolRun(state, result.callId);
  return record !== undefined && record.toolName === result.toolName;
}

function writeToolRuns<T extends { readonly state?: SessionStateMap }>(
  session: T,
  records: readonly ToolRunRecord[],
): T {
  const state = { ...session.state };
  if (records.length === 0) {
    delete state[TOOL_RUNS_STATE_KEY];
  } else {
    state[TOOL_RUNS_STATE_KEY] = records;
  }
  return { ...session, state: Object.keys(state).length > 0 ? state : undefined };
}
