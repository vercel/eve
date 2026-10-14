import { describe, expect, it, vi } from "vitest";

import type { SessionInbox } from "#execution/session-inbox/inbox.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { workingTaskIds } from "#execution/tasks/session.js";
import {
  createTask,
  markTaskRunStarted,
  readTaskTable,
  recordTaskRun,
  writeTaskTable,
  type TaskTable,
} from "#execution/tasks/table.js";
import { createTestSessionState } from "#internal/testing/session-state.js";

describe("workingTaskIds", () => {
  const research = startedTask(readTaskTable(undefined), "research", "turn_B");
  const summarize = startedTask(research.table, "summarize", "turn_B");
  const lint = startedTask(summarize.table, "lint", "turn_C");
  const cursor = new SessionStateCursor({
    history: [],
    inbox: { claimSessionHooks: vi.fn() } as Partial<SessionInbox> as SessionInbox,
    serializedContext: {},
    sessionState: (() => {
      const state = createTestSessionState({ sessionId: "session-1" });
      return {
        ...state,
        snapshot: { session: writeTaskTable(state.snapshot.session, lint.table) },
      };
    })(),
    sessionWritable: new WritableStream<Uint8Array>(),
  });

  it.each([
    { turnId: undefined, expected: [research.taskId, summarize.taskId, lint.taskId] },
    { turnId: "turn_B", expected: [research.taskId, summarize.taskId] },
    { turnId: "turn_C", expected: [lint.taskId] },
    { turnId: "turn_A", expected: [] },
  ])("cancel of $turnId targets $expected", ({ turnId, expected }) => {
    expect(workingTaskIds(cursor, turnId)).toEqual(expected);
  });
});

/** A working `task()` task whose run has started. */
function startedTask(
  table: TaskTable,
  name: string,
  turnId: string,
): { readonly table: TaskTable; readonly taskId: string } {
  const created = createTask(table, {
    callId: `${name}-call`,
    kind: "tool",
    name,
    resumable: false,
    turnId,
  });
  const runId = `${name}-run`;
  const recorded = recordTaskRun(created.table, created.taskId, {
    hookToken: `${runId}-control`,
    runId,
  });
  return {
    table: markTaskRunStarted(recorded, created.taskId, runId).table,
    taskId: created.taskId,
  };
}
