import { jsonValuesEqual } from "#shared/json.js";
import { readApprovedToolKeys, writeApprovedToolKeys } from "#harness/hitl/approved-tools.js";
import type { SessionStateMap } from "#harness/types.js";
import type { SandboxState } from "#sandbox/state.js";
import type { DurableSession } from "#execution/durable-session-store.js";
import type { WorkflowToolRunCodeModeContext } from "#execution/tools/workflow/types.js";

export interface CodeModeStateChange {
  readonly path: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
}

export function diffCodeModeState(
  before: unknown,
  after: unknown,
  path: readonly string[] = [],
): CodeModeStateChange[] {
  if (jsonValuesEqual(before, after)) return [];
  if (isRecord(before) && isRecord(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      diffCodeModeState(
        Object.hasOwn(before, key) ? before[key] : undefined,
        Object.hasOwn(after, key) ? after[key] : undefined,
        [...path, key],
      ),
    );
  }
  // New objects are split into leaves so parallel reads of different files
  // do not overwrite each other's stamps when the context key was absent.
  if (before === undefined && isRecord(after) && Object.keys(after).length > 0) {
    return Object.entries(after).flatMap(([key, value]) =>
      diffCodeModeState(undefined, value, [...path, key]),
    );
  }
  return [{ path, before, after }];
}

/** Applies only changed fields; conflicting concurrent writes fail explicitly. */
export function applyCodeModeStateChanges<T>(state: T, changes: readonly CodeModeStateChange[]): T {
  let current: unknown = state;
  for (const change of changes) current = applyChange(current, change, 0);
  return current as T;
}

function applyChange(value: unknown, change: CodeModeStateChange, depth: number): unknown {
  if (depth === change.path.length) {
    if (jsonValuesEqual(value, change.after)) return value;
    if (!jsonValuesEqual(value, change.before)) {
      throw new Error(`CODE_MODE_STATE_CONFLICT: concurrent writes to ${change.path.join(".")}.`);
    }
    return change.after;
  }
  if (value !== undefined && !isRecord(value)) {
    throw new Error("CODE_MODE_STATE_CONFLICT: a parent field changed during execution.");
  }
  const key = change.path[depth]!;
  const record = isRecord(value) ? value : {};
  const next = applyChange(Object.hasOwn(record, key) ? record[key] : undefined, change, depth + 1);
  const updated = { ...record, [key]: next };
  if (next === undefined) delete updated[key];
  return updated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The session fields nested calls may change. Approval keys are keyed by name
 * so two calls approved in one batch merge instead of conflicting.
 */
export function codeModeSessionState(
  session:
    | {
        readonly sandboxState?: SandboxState;
        readonly state?: SessionStateMap;
      }
    | undefined,
) {
  const approvedTools: Record<string, true> = {};
  for (const key of readApprovedToolKeys(session?.state)) approvedTools[key] = true;
  return {
    sandboxState: session?.sandboxState,
    approvedTools: Object.keys(approvedTools).length === 0 ? undefined : approvedTools,
  };
}

export function codeModeMutableState(state: WorkflowToolRunCodeModeContext) {
  return {
    serializedContext: state.serializedContext,
    ...codeModeSessionState(state.sessionState.snapshot?.session),
  };
}

/** The change a granted approval contributes, so `once()` holds for later calls and the parent. */
export function approvedToolStateChange(approvalKey: string): CodeModeStateChange {
  return { path: ["approvedTools", approvalKey], before: undefined, after: true };
}

export function adoptCodeModeStateChanges(
  state: WorkflowToolRunCodeModeContext,
  changes: readonly CodeModeStateChange[],
): WorkflowToolRunCodeModeContext {
  const updated = applyCodeModeStateChanges(codeModeMutableState(state), changes);
  const snapshot = state.sessionState.snapshot;
  if (snapshot === undefined) {
    return { serializedContext: updated.serializedContext, sessionState: state.sessionState };
  }
  const sessionStateMap = writeApprovedToolKeys(
    snapshot.session.state,
    Object.keys(updated.approvedTools ?? {}),
  );
  const session: { -readonly [K in keyof DurableSession]: DurableSession[K] } = {
    ...snapshot.session,
    sandboxState: updated.sandboxState,
  };
  if (sessionStateMap !== undefined) session.state = sessionStateMap;
  return {
    serializedContext: updated.serializedContext,
    sessionState: { ...state.sessionState, snapshot: { ...snapshot, session } },
  };
}
