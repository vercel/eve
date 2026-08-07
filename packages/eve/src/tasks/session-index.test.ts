import { describe, expect, it } from "vitest";

import type { HarnessSession } from "#harness/types.js";
import {
  SESSION_TASKS_STATE_KEY,
  findSessionTaskEntry,
  getSessionTaskIndex,
  recordSessionTask,
} from "#tasks/session-index.js";
import { deriveTaskId } from "#tasks/task-id.js";
function createSession(state?: HarnessSession["state"]): HarnessSession {
  return {
    agent: {
      modelReference: { id: "model_test" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "continuation_test",
    history: [],
    sessionId: "session_parent",
    state,
  };
}

describe("session task index", () => {
  const metadata = {
    agentId: "ag_research:abcdef123456",
    kind: "subagent" as const,
    mode: "local" as const,
    name: "research",
  };
  it("returns an empty index when the key is absent", () => {
    expect(getSessionTaskIndex({})).toEqual([]);
    expect(getSessionTaskIndex(undefined)).toEqual([]);
  });

  it("records a task and finds it by id", () => {
    const session = recordSessionTask(createSession(), {
      commandToken: "task:token-1",
      createdByTurnId: "turn-1",
      metadata,
      operationId: "operation-1",
      taskId: "task_a",
      taskRunId: "run-1",
    });

    expect(findSessionTaskEntry(session.state, "task_a")).toEqual({
      commandToken: "task:token-1",
      createdByTurnId: "turn-1",
      metadata,
      operationId: "operation-1",
      taskId: "task_a",
      taskRunId: "run-1",
    });
    expect(findSessionTaskEntry(session.state, "task_other")).toBeUndefined();
  });

  it("replaces the entry on replayed creation instead of duplicating it", () => {
    let session = recordSessionTask(createSession(), {
      commandToken: "task:token-1",
      createdByTurnId: "turn-1",
      metadata,
      operationId: "operation-1",
      taskId: "task_a",
      taskRunId: "run-1",
    });
    session = recordSessionTask(session, {
      commandToken: "task:token-2",
      createdByTurnId: "turn-1",
      metadata,
      operationId: "operation-1",
      taskId: "task_a",
      taskRunId: "run-2",
    });

    const entries = getSessionTaskIndex(session.state);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.taskRunId).toBe("run-2");
  });

  it("retains only terminal snapshots as expired-run fallbacks", () => {
    const base = {
      commandToken: "task:token-1",
      createdByTurnId: "turn-1",
      metadata,
      operationId: "operation-1",
      taskId: "task_a",
      taskRunId: "run-1",
    };
    const terminalSnapshot = {
      lastOutput: { data: "done", type: "result" as const },
      metadata,
      status: "completed" as const,
      taskId: "task_a",
    };

    const session = recordSessionTask(createSession(), { ...base, terminalSnapshot });
    expect(findSessionTaskEntry(session.state, "task_a")?.terminalSnapshot).toEqual(
      terminalSnapshot,
    );
    for (const invalidSnapshot of [
      { metadata, status: "working", taskId: "task_a" },
      { metadata, status: "completed", taskId: "task_a" },
      {
        lastOutput: { data: "wrong", type: "result" },
        metadata,
        status: "failed",
        taskId: "task_a",
      },
      {
        lastOutput: { data: "wrong", type: "result" },
        metadata,
        status: "cancelled",
        taskId: "task_a",
      },
      {
        inputRequests: [{ requestId: "stale" }],
        lastOutput: { data: "done", type: "result" },
        metadata,
        status: "completed",
        taskId: "task_a",
      },
      { ...terminalSnapshot, taskId: "task_other" },
    ]) {
      expect(() =>
        getSessionTaskIndex({
          [SESSION_TASKS_STATE_KEY]: {
            tasks: [{ ...base, terminalSnapshot: invalidSnapshot }],
          },
        }),
      ).toThrow(`Corrupt task index under session state key "${SESSION_TASKS_STATE_KEY}"`);
    }
  });

  it("throws on a corrupt index instead of treating it as absent", () => {
    expect(() =>
      getSessionTaskIndex({ [SESSION_TASKS_STATE_KEY]: { tasks: [{ taskId: 42 }] } }),
    ).toThrow(`Corrupt task index under session state key "${SESSION_TASKS_STATE_KEY}"`);
  });
});

describe("deriveTaskId", () => {
  it("is deterministic for the same originating call and distinct otherwise", () => {
    const input = { callId: "call-1", parentSessionId: "session-1", parentTurnId: "turn-1" };

    expect(deriveTaskId(input)).toBe(deriveTaskId(input));
    expect(deriveTaskId(input)).toMatch(/^task_[0-9a-f]{24}$/);
    expect(deriveTaskId({ ...input, callId: "call-2" })).not.toBe(deriveTaskId(input));
  });
});
