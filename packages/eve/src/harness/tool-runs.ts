import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";

const TOOL_RUNS_STATE_KEY = "eve.runtime.toolRuns";

/**
 * One authored workflow tool run the session's active turn is waiting on.
 *
 * Recorded by the dispatch step when the run starts and removed when its
 * result resolves the call, so the turn can bind inbox results, route input
 * requests, and cancel the run with the turn. Background tool runs are not
 * recorded here; the task index owns them.
 */
export interface ToolRunRecord {
  readonly callId: string;
  /** The run's inbox hook: its identity claim and the route for input answers. */
  readonly hookToken: string;
  readonly runId: string;
  readonly toolName: string;
}

/**
 * Schema-free read. Every write goes through {@link recordToolRun} and
 * {@link removeToolRun}, which keeps the workflow driver bundle free of the
 * validation runtime.
 */
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

/**
 * A tool result arriving over the shared turn inbox settles a call only when
 * the turn recorded a run for that call and the result names the same tool.
 * Anything else — a stale result for a resolved call, or one for a call that
 * never dispatched — is dropped.
 */
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
