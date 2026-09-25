import type { SessionStateMap } from "#harness/types.js";
import { TASK_RECORD_VERSION, type TaskRecord } from "#tasks/record.js";
import { readTaskTable, TASK_TABLE_STATE_KEY, type TaskTable } from "#tasks/table.js";

/**
 * One agent task record with test defaults: a working attached call with no
 * child yet. An agent task is resumable, as the owner starts every one.
 */
export function createTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const record: TaskRecord = {
    callId: "call-1",
    delivered: false,
    generation: 1,
    id: "research-abc234",
    kind: "agent",
    mode: "attached",
    name: "research",
    nodeId: "subagents/research",
    startedAt: "2026-09-24T14:00:00.000Z",
    status: "working",
    turnId: "turn-1",
    v: TASK_RECORD_VERSION,
  };
  const agent = overrides.kind === undefined || overrides.kind === "agent";
  return agent ? { ...record, resumable: true, ...overrides } : { ...record, ...overrides };
}

/** Session state holding the given task records. */
export function taskTableState(records: readonly TaskRecord[]): SessionStateMap {
  return { [TASK_TABLE_STATE_KEY]: { records } };
}

/** A task table holding the given records, decoded the way the owner reads it. */
export function taskTable(records: readonly TaskRecord[]): TaskTable {
  return readTaskTable(taskTableState(records)).table;
}
