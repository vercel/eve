import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { isNonEmptyString, isObject } from "#shared/guards.js";
import type { SessionStateMap } from "#harness/types.js";
import { readRunningWork, writeRunningWork } from "#harness/running-work.js";

/**
 * The workflow runs a turn waits on, by the call each serves: the calls part of the session's
 * record of running work (`running-work.ts`), which also holds its tasks.
 */

/** One workflow tool call the originating turn waits on. */
export interface BlockingWorkflowToolRun {
  readonly callId: string;
  readonly toolName: string;
  readonly origin: { readonly turnId: string; readonly stepIndex: number };
  readonly address: { readonly runId: string; readonly hookToken: string };
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

function parseRuns(value: readonly unknown[]): readonly BlockingWorkflowToolRun[] {
  if (!value.every(isWorkflowToolRun)) {
    throw new Error("Corrupt workflow tool run registry: invalid run.");
  }
  const identities = new Set<string>();
  for (const entry of value) {
    const identity = JSON.stringify([entry.origin.turnId, entry.callId]);
    if (identities.has(identity))
      throw new Error("Corrupt workflow tool run registry: Run identities must be unique.");
    identities.add(identity);
  }
  return value.map(copyWorkflowToolRun);
}

function copyWorkflowToolRun(entry: BlockingWorkflowToolRun): BlockingWorkflowToolRun {
  return { ...entry, origin: { ...entry.origin }, address: { ...entry.address } };
}

function readRuns(state: SessionStateMap | undefined): readonly BlockingWorkflowToolRun[] {
  return parseRuns(readRunningWork(state).calls);
}

function writeRuns(
  state: SessionStateMap | undefined,
  runs: readonly BlockingWorkflowToolRun[],
): SessionStateMap | undefined {
  return writeRunningWork(state, { calls: parseRuns(runs) });
}

export function getBlockingWorkflowToolRuns(
  state: SessionStateMap | undefined,
  turnId?: string,
): readonly BlockingWorkflowToolRun[] {
  return readRuns(state).filter((entry) => turnId === undefined || entry.origin.turnId === turnId);
}

/** Registration is idempotent by originating turn and call. */
export function registerWorkflowToolRun<T extends { readonly state?: SessionStateMap }>(
  session: T,
  entry: BlockingWorkflowToolRun,
): T {
  const runs = [...readRuns(session.state)];
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
  return { ...session, state: writeRuns(session.state, runs) };
}

/** Removes this turn's waiting calls, or only one of them when `callId` is given. */
export function removeBlockingWorkflowToolRuns<T extends { readonly state?: SessionStateMap }>(
  session: T,
  turnId: string,
  callId?: string,
): T {
  const entries = readRuns(session.state);
  const remaining = entries.filter(
    (entry) => entry.origin.turnId !== turnId || (callId !== undefined && entry.callId !== callId),
  );
  return remaining.length === entries.length
    ? session
    : { ...session, state: writeRuns(session.state, remaining) };
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
