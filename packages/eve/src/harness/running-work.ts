import { isObject } from "#shared/guards.js";
import type { SessionStateMap } from "#harness/types.js";

/**
 * The session's one record of running work, in its private state: the workflow runs a turn waits
 * on, by the call each serves, and the tasks, each with the calls it serves. The stop path, the
 * session's end, and handoff read every run from here. Each part has one owner module that
 * decodes and writes it: `workflow-tool-runs.ts` for calls, `execution/tasks/table.ts` for tasks.
 */
const RUNNING_WORK_STATE_KEY = "eve.work";
const RUNNING_WORK_VERSION = 1;

/**
 * Keys of the stores this record replaced. A checkpoint upgrade moves the last two into this
 * record, so a state that still holds one was written by another build.
 */
const RETIRED_KEYS = [
  "eve.tasks",
  "eve.runtime.workflowToolRuns",
  "eve.workflowTool",
  "eve.taskTable",
];

export interface RunningWork {
  /** Workflow runs a turn waits on, as `workflow-tool-runs.ts` encodes them. */
  readonly calls: readonly unknown[];
  /** Tasks, as `execution/tasks/table.ts` encodes them. */
  readonly tasks: readonly unknown[];
}

export function readRunningWork(state: SessionStateMap | undefined): RunningWork {
  if (RETIRED_KEYS.some((key) => state?.[key] !== undefined)) {
    throw new Error(
      "Unsupported running-work state: start a new session or import its conversation.",
    );
  }
  const raw = state?.[RUNNING_WORK_STATE_KEY];
  if (raw === undefined) return { calls: [], tasks: [] };
  if (
    !isObject(raw) ||
    raw.version !== RUNNING_WORK_VERSION ||
    (raw.calls !== undefined && !Array.isArray(raw.calls)) ||
    (raw.tasks !== undefined && !Array.isArray(raw.tasks))
  ) {
    throw new Error("Corrupt running-work record: invalid version or shape.");
  }
  return {
    calls: Array.isArray(raw.calls) ? Array.from(raw.calls as unknown[]) : [],
    tasks: Array.isArray(raw.tasks) ? Array.from(raw.tasks as unknown[]) : [],
  };
}

/** Replaces one part of the record; the record leaves the state once nothing runs. */
export function writeRunningWork(
  state: SessionStateMap | undefined,
  part: Partial<RunningWork>,
): SessionStateMap | undefined {
  const current = readRunningWork(state);
  const calls = part.calls ?? current.calls;
  const tasks = part.tasks ?? current.tasks;
  if (calls.length === 0 && tasks.length === 0) {
    const next = { ...state };
    delete next[RUNNING_WORK_STATE_KEY];
    return Object.keys(next).length === 0 ? undefined : next;
  }
  const record: { version: number; calls?: readonly unknown[]; tasks?: readonly unknown[] } = {
    version: RUNNING_WORK_VERSION,
  };
  if (calls.length > 0) record.calls = calls;
  if (tasks.length > 0) record.tasks = tasks;
  return { ...state, [RUNNING_WORK_STATE_KEY]: record };
}
