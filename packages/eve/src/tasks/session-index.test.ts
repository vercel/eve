import { describe, expect, it } from "vitest";

import type { HarnessSession } from "#harness/types.js";
import { SESSION_TASKS_STATE_KEY } from "#tasks/session-index-state-key.js";
import {
  clearObservedReadyTask,
  findSessionTaskEntry,
  getSessionTaskIndex,
  recordObservedReadyTaskViews,
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
  const taskEntry = {
    taskInboxToken: "task:token-1",
    createdByTurnId: "turn-1",
    metadata,
    operationId: "operation-1",
    taskId: "task_a",
    taskRunId: "run-1",
  };

  function createTaskSession(): HarnessSession {
    return recordSessionTask(createSession(), taskEntry);
  }

  it("returns an empty index when the key is absent", () => {
    expect(getSessionTaskIndex({})).toEqual([]);
    expect(getSessionTaskIndex(undefined)).toEqual([]);
  });

  it("records a task and finds it by id", () => {
    const session = recordSessionTask(createSession(), {
      taskInboxToken: "task:token-1",
      createdByTurnId: "turn-1",
      metadata,
      operationId: "operation-1",
      taskId: "task_a",
      taskRunId: "run-1",
    });

    expect(findSessionTaskEntry(session.state, "task_a")).toEqual({
      taskInboxToken: "task:token-1",
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
      taskInboxToken: "task:token-1",
      createdByTurnId: "turn-1",
      metadata,
      operationId: "operation-1",
      taskId: "task_a",
      taskRunId: "run-1",
    });
    session = recordSessionTask(session, {
      taskInboxToken: "task:token-2",
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

  it("retains the parent's peek observation across replayed creation", () => {
    const first = recordSessionTask(createSession(), {
      taskInboxToken: "task:token-1",
      createdByTurnId: "turn-1",
      lastPeekedReadyStatus: "completed",
      metadata,
      operationId: "operation-1",
      taskId: "task_a",
      taskRunId: "run-1",
    });
    const replayed = recordSessionTask(first, {
      taskInboxToken: "task:token-2",
      createdByTurnId: "turn-1",
      metadata,
      operationId: "operation-1",
      taskId: "task_a",
      taskRunId: "run-2",
    });

    expect(findSessionTaskEntry(replayed.state, "task_a")).toMatchObject({
      lastPeekedReadyStatus: "completed",
      taskRunId: "run-2",
    });
  });

  it("retains only terminal views as expired-run fallbacks", () => {
    const base = {
      taskInboxToken: "task:token-1",
      createdByTurnId: "turn-1",
      metadata,
      operationId: "operation-1",
      taskId: "task_a",
      taskRunId: "run-1",
    };
    const terminalView = {
      lastOutput: { data: "done", type: "result" as const },
      metadata,
      status: "completed" as const,
      taskId: "task_a",
    };

    const session = recordSessionTask(createSession(), { ...base, terminalView });
    expect(findSessionTaskEntry(session.state, "task_a")?.terminalView).toEqual(terminalView);
    for (const invalidView of [
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
      { ...terminalView, taskId: "task_other" },
    ]) {
      expect(() =>
        getSessionTaskIndex({
          [SESSION_TASKS_STATE_KEY]: {
            tasks: [{ ...base, terminalView: invalidView }],
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

  it("records ready views returned by task_peek", () => {
    const observed = recordObservedReadyTaskViews(createTaskSession(), [
      {
        lastOutput: { data: "done", type: "result" },
        metadata,
        status: "completed",
        taskId: "task_a",
      },
    ]);

    expect(findSessionTaskEntry(observed.state, "task_a")?.lastPeekedReadyStatus).toBe("completed");
  });

  it("clears an observed input_required view after its answer resumes the task", () => {
    const observed = recordObservedReadyTaskViews(createTaskSession(), [
      {
        inputRequests: [{ requestId: "request-1" }],
        metadata,
        status: "input_required",
        taskId: "task_a",
      },
    ]);
    const cleared = clearObservedReadyTask(observed.state, "task_a");

    expect(findSessionTaskEntry(cleared, "task_a")?.lastPeekedReadyStatus).toBeUndefined();
  });

  it("clears a prior ready observation when a later task_peek returns working", () => {
    const observed = recordObservedReadyTaskViews(createTaskSession(), [
      {
        inputRequests: [{ requestId: "request-1" }],
        metadata,
        status: "input_required",
        taskId: "task_a",
      },
    ]);
    const working = recordObservedReadyTaskViews(observed, [
      { metadata, status: "working", taskId: "task_a" },
    ]);

    expect(findSessionTaskEntry(working.state, "task_a")?.lastPeekedReadyStatus).toBeUndefined();
  });

  it("rejects a non-ready peek observation", () => {
    expect(() =>
      getSessionTaskIndex({
        [SESSION_TASKS_STATE_KEY]: {
          tasks: [{ ...taskEntry, lastPeekedReadyStatus: "working" }],
        },
      }),
    ).toThrow(`Corrupt task index under session state key`);
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
