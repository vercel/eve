import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { isNonEmptyString, isObject } from "#shared/guards.js";
import type { SessionStateMap } from "#harness/types.js";

export const WORKFLOW_TOOL_RUNS_STATE_KEY = "eve.workflowTool";
const WORKFLOW_TOOL_RUNS_VERSION = 3;

/** One workflow tool run started by, and owned by, the turn that called the tool. */
export interface BlockingWorkflowToolRun {
  readonly callId: string;
  readonly toolName: string;
  readonly lifetime: "turn";
  readonly origin: { readonly turnId: string; readonly stepIndex: number };
  readonly address: { readonly runId: string; readonly hookToken: string };
}

interface WorkflowToolRunRegistry {
  readonly version: typeof WORKFLOW_TOOL_RUNS_VERSION;
  readonly runs: readonly BlockingWorkflowToolRun[];
}

// These readers run inside the workflow driver: importing a schema runtime here also
// embeds it and its source map in every deployed workflow function.
function isBlockingWorkflowToolRun(value: unknown): value is BlockingWorkflowToolRun {
  return (
    isObject(value) &&
    value.lifetime === "turn" &&
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

/**
 * Keeps each valid run and drops anything else, so one unreadable record
 * (including runs written by releases that supported background tools) never
 * fails the session.
 */
function readRegistry(state: SessionStateMap | undefined): WorkflowToolRunRegistry {
  const raw = state?.[WORKFLOW_TOOL_RUNS_STATE_KEY];
  if (!isObject(raw) || !Array.isArray(raw.runs)) {
    return { version: WORKFLOW_TOOL_RUNS_VERSION, runs: [] };
  }
  const identities = new Set<string>();
  const runs: BlockingWorkflowToolRun[] = [];
  for (const entry of Array.from(raw.runs)) {
    if (!isBlockingWorkflowToolRun(entry)) continue;
    const identity = JSON.stringify([entry.origin.turnId, entry.callId]);
    if (identities.has(identity)) continue;
    identities.add(identity);
    runs.push({ ...entry, origin: { ...entry.origin }, address: { ...entry.address } });
  }
  return { version: WORKFLOW_TOOL_RUNS_VERSION, runs };
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
  return { ...state, [WORKFLOW_TOOL_RUNS_STATE_KEY]: registry };
}

export function getBlockingWorkflowToolRuns(
  state: SessionStateMap | undefined,
  turnId?: string,
): readonly BlockingWorkflowToolRun[] {
  return readRegistry(state).runs.filter(
    (entry) => turnId === undefined || entry.origin.turnId === turnId,
  );
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

/** Removes only this turn's waiting calls. */
export function removeBlockingWorkflowToolRuns<T extends { readonly state?: SessionStateMap }>(
  session: T,
  turnId: string,
  callId?: string,
): T {
  const registry = readRegistry(session.state);
  const remaining = registry.runs.filter(
    (entry) => entry.origin.turnId !== turnId || (callId !== undefined && entry.callId !== callId),
  );
  return remaining.length === registry.runs.length
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
