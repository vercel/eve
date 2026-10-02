import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { isNonEmptyString, isObject } from "#shared/guards.js";
import type { SessionStateMap } from "#harness/types.js";

export const WORKFLOW_TOOL_RUNS_STATE_KEY = "eve.workflowTool";
// Version 4 records only runs a turn waits on; earlier versions also held session-owned runs.
const WORKFLOW_TOOL_RUNS_VERSION = 4;

/** One workflow tool call the originating turn waits on. */
export interface BlockingWorkflowToolRun {
  readonly callId: string;
  readonly toolName: string;
  readonly origin: { readonly turnId: string; readonly stepIndex: number };
  readonly address: { readonly runId: string; readonly hookToken: string };
}

interface WorkflowToolRunRegistry {
  readonly version: typeof WORKFLOW_TOOL_RUNS_VERSION;
  readonly runs: readonly BlockingWorkflowToolRun[];
  readonly [key: string]: unknown;
}

// These readers run inside the workflow driver: importing a schema runtime here also
// embeds it and its source map in every deployed workflow function.
function isWorkflowToolRun(value: unknown): value is BlockingWorkflowToolRun {
  return (
    isObject(value) &&
    isNonEmptyString(value.callId) &&
    isNonEmptyString(value.toolName) &&
    isObject(value.origin) &&
    isNonEmptyString(value.origin.turnId) &&
    typeof value.origin.stepIndex === "number" &&
    Number.isSafeInteger(value.origin.stepIndex) &&
    value.origin.stepIndex >= 0 &&
    isObject(value.address) &&
    isNonEmptyString(value.address.runId) &&
    isNonEmptyString(value.address.hookToken)
  );
}

function parseRegistry(value: unknown): WorkflowToolRunRegistry {
  if (
    !isObject(value) ||
    value.version !== WORKFLOW_TOOL_RUNS_VERSION ||
    !Array.isArray(value.runs) ||
    !Array.from(value.runs).every(isWorkflowToolRun)
  ) {
    throw new Error("Corrupt workflow tool run registry: invalid version or run.");
  }
  const identities = new Set<string>();
  for (const entry of value.runs) {
    const identity = JSON.stringify([entry.origin.turnId, entry.callId]);
    if (identities.has(identity))
      throw new Error("Corrupt workflow tool run registry: Run identities must be unique.");
    identities.add(identity);
  }
  return {
    ...value,
    version: WORKFLOW_TOOL_RUNS_VERSION,
    runs: value.runs.map(copyWorkflowToolRun),
  };
}

function copyWorkflowToolRun(entry: BlockingWorkflowToolRun): BlockingWorkflowToolRun {
  return { ...entry, origin: { ...entry.origin }, address: { ...entry.address } };
}

function readRegistry(state: SessionStateMap | undefined): WorkflowToolRunRegistry {
  const raw = state?.[WORKFLOW_TOOL_RUNS_STATE_KEY];
  if (isUnsupportedState(state, raw)) {
    throw new Error(
      "Unsupported workflow tool run state: start a new session or import its conversation.",
    );
  }
  if (raw === undefined) return { version: WORKFLOW_TOOL_RUNS_VERSION, runs: [] };
  return parseRegistry(raw);
}

function isUnsupportedState(state: SessionStateMap | undefined, raw: unknown): boolean {
  const hasRetiredStore =
    state?.["eve.tasks"] !== undefined || state?.["eve.runtime.workflowToolRuns"] !== undefined;
  const hasEarlierVersion = isObject(raw) && raw.version !== WORKFLOW_TOOL_RUNS_VERSION;
  return hasRetiredStore || hasEarlierVersion;
}

export function getBlockingWorkflowToolRuns(
  state: SessionStateMap | undefined,
  turnId?: string,
): readonly BlockingWorkflowToolRun[] {
  return readRegistry(state).runs.filter(
    (entry) => turnId === undefined || entry.origin.turnId === turnId,
  );
}

function writeRegistry(
  state: SessionStateMap | undefined,
  registry: WorkflowToolRunRegistry,
): SessionStateMap | undefined {
  if (registry.runs.length === 0) {
    const next = { ...state };
    delete next[WORKFLOW_TOOL_RUNS_STATE_KEY];
    return Object.keys(next).length === 0 ? undefined : next;
  }
  return {
    ...state,
    [WORKFLOW_TOOL_RUNS_STATE_KEY]: parseRegistry(registry),
  };
}

/** Registration is idempotent by originating turn and call. */
export function registerWorkflowToolRun<T extends { readonly state?: SessionStateMap }>(
  session: T,
  entry: BlockingWorkflowToolRun,
): T {
  const registry = readRegistry(session.state);
  const runs = [...registry.runs];
  const index = runs.findIndex(
    (candidate) =>
      candidate.origin.turnId === entry.origin.turnId && candidate.callId === entry.callId,
  );
  const previous = runs[index];
  if (previous !== undefined && previous.toolName !== entry.toolName) {
    throw new Error("Replayed invocation changed its tool identity.");
  }
  if (previous === undefined) runs.push(entry);
  else
    runs[index] = {
      ...previous,
      ...entry,
      origin: previous.origin,
      address: { ...previous.address, ...entry.address },
    };
  return { ...session, state: writeRegistry(session.state, { ...registry, runs }) };
}

/** Removes this turn's waiting calls, or only one of them when `callId` is given. */
export function removeBlockingWorkflowToolRuns<T extends { readonly state?: SessionStateMap }>(
  session: T,
  turnId: string,
  callId?: string,
): T {
  const registry = readRegistry(session.state);
  const entries = registry.runs;
  const remaining = entries.filter(
    (entry) => entry.origin.turnId !== turnId || (callId !== undefined && entry.callId !== callId),
  );
  return remaining.length === entries.length
    ? session
    : { ...session, state: writeRegistry(session.state, { ...registry, runs: remaining }) };
}

/** Results without an originating turn may bind only when exactly one recorded turn owns the call. */
export function findBlockingWorkflowToolRun(
  state: SessionStateMap | undefined,
  callId: string,
  turnId?: string,
): BlockingWorkflowToolRun | undefined {
  const candidates = getBlockingWorkflowToolRuns(state, turnId).filter(
    (entry) => entry.callId === callId,
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** The turn inbox is shared; a result settles a call only if the turn recorded that run. */
export function isInboxToolResultFromRecordedWorkflowToolRun(
  state: SessionStateMap | undefined,
  result: RuntimeToolResultActionResult,
): boolean {
  const record = findBlockingWorkflowToolRun(state, result.callId);
  return record !== undefined && record.toolName === result.toolName;
}
