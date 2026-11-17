import { isObject } from "#shared/guards.js";
import type { SessionStateMap } from "#harness/types.js";

const RUNNING_WORK_STATE_KEY = "eve.work";
const RUNNING_WORK_VERSION = 1;

export interface RunningWork {
  readonly calls: readonly unknown[];
  readonly tasks: readonly unknown[];
}

export function readRunningWork(state: SessionStateMap | undefined): RunningWork {
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
