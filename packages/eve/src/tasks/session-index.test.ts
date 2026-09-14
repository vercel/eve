import { describe, expect, it } from "vitest";

import type { HarnessSession } from "#harness/types.js";
import {
  SESSION_TASKS_STATE_KEY,
  cacheTerminalTaskView,
  findSessionTaskEntry,
  getSessionTaskIndex,
  recordSessionTask,
} from "#tasks/session-index.js";
import { getTaskCohortId, getSessionTaskCohorts } from "#tasks/session-task-cohorts.js";
import { deriveTaskId } from "#tasks/task-id.js";
import type { TaskView } from "#tasks/types.js";

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
    kind: "tool" as const,
    name: "research",
  };
  it("returns an empty index when the key is absent", () => {
    expect(getSessionTaskIndex({})).toEqual([]);
    expect(getSessionTaskIndex(undefined)).toEqual([]);
  });

  it("records a task and finds it by id", () => {
    const session = recordSessionTask(createSession(), {
      taskInboxToken: "task:token-1",
      createdByTurnId: "turn-1",
      metadata,
      taskId: "task_a",
      taskRunId: "run-1",
    });

    expect(findSessionTaskEntry(session.state, "task_a")).toEqual({
      taskInboxToken: "task:token-1",
      createdByTurnId: "turn-1",
      metadata,
      taskId: "task_a",
      taskRunId: "run-1",
    });
    expect(findSessionTaskEntry(session.state, "task_other")).toBeUndefined();
  });

  it("keeps subagent metadata in the persisted task index", () => {
    const subagentMetadata = {
      agentId: "ag_worker",
      kind: "subagent",
      mode: "remote",
      name: "research",
    } as const;

    const session = recordSessionTask(createSession(), {
      taskInboxToken: "task:token-1",
      createdByTurnId: "turn-1",
      metadata: subagentMetadata,
      taskId: "task_a",
      taskRunId: "run-1",
    });

    expect(findSessionTaskEntry(session.state, "task_a")?.metadata).toEqual(subagentMetadata);
  });

  it("replaces the entry on replayed creation instead of duplicating it", () => {
    let session = recordSessionTask(createSession(), {
      taskInboxToken: "task:token-1",
      createdByTurnId: "turn-1",
      metadata,
      taskId: "task_a",
      taskRunId: "run-1",
    });
    session = recordSessionTask(session, {
      taskInboxToken: "task:token-2",
      createdByTurnId: "turn-1",
      metadata,
      taskId: "task_a",
      taskRunId: "run-2",
    });

    const entries = getSessionTaskIndex(session.state);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.taskRunId).toBe("run-2");
  });

  function task(taskId: string, createdByTurnId: string) {
    return {
      createdByStepIndex: 0,
      createdByTurnId,
      metadata,
      taskId,
      taskInboxToken: `inbox-${taskId}`,
      taskRunId: `run-${taskId}`,
    };
  }

  function terminal(taskId: string, status: "completed" | "failed" | "cancelled"): TaskView {
    if (status === "cancelled") return { metadata, status, taskId };
    return status === "completed"
      ? { metadata, status, taskId, lastOutput: { type: "result", data: "done" } }
      : { metadata, status, taskId, lastOutput: { type: "error", data: "failed" } };
  }

  it("durably joins overlapping work across turns and executor kinds", () => {
    const first = task("task_a", "turn-1");
    const initial = recordSessionTask(createSession(), first);
    const second = {
      ...task("task_b", "turn-2"),
      executor: { kind: "workflow-tool", data: {} },
    };
    const session = recordSessionTask(initial, second);
    const entries = getSessionTaskIndex(session.state);
    expect(entries.map(getTaskCohortId)).toEqual(["task_a", "task_a"]);
    expect(entries.map((entry) => entry.createdByTurnId)).toEqual(["turn-1", "turn-2"]);
    expect(entries[0]?.cohortId).toBeUndefined();
    expect(entries[1]?.cohortId).toBe("task_a");
    const restored = createSession(JSON.parse(JSON.stringify(initial.state)));
    expect(recordSessionTask(restored, second).state).toEqual(session.state);
    expect(getSessionTaskIndex(initial.state)).toHaveLength(1);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "keeps a %s sibling in a pending cohort, then starts a new cohort after settlement",
    (status) => {
      let session = recordSessionTask(createSession(), task("task_a", "turn-1"));
      session = recordSessionTask(session, task("task_b", "turn-1"));
      session = {
        ...session,
        state: cacheTerminalTaskView(session.state, terminal("task_a", status)),
      };
      session = recordSessionTask(session, task("task_c", "turn-2"));
      expect(getSessionTaskIndex(session.state).map(getTaskCohortId)).toEqual([
        "task_a",
        "task_a",
        "task_a",
      ]);
      expect([...getSessionTaskCohorts(session.state).values()]).toEqual([
        { cohortId: "task_a", settled: true },
        { cohortId: "task_a", settled: false },
        { cohortId: "task_a", settled: false },
      ]);
      for (const taskId of ["task_b", "task_c"]) {
        session = {
          ...session,
          state: cacheTerminalTaskView(session.state, terminal(taskId, status)),
        };
      }
      // Even another creation in the same turn must not reopen a settled cohort.
      session = recordSessionTask(session, task("task_d", "turn-2"));
      expect(getSessionTaskIndex(session.state).map(getTaskCohortId)).toEqual([
        "task_a",
        "task_a",
        "task_a",
        "task_d",
      ]);
    },
  );

  it("preserves replayed membership, creation provenance, order, and settlement", () => {
    let session = recordSessionTask(createSession(), task("task_a", "turn-1"));
    session = recordSessionTask(session, task("task_b", "turn-2"));
    for (const taskId of ["task_a", "task_b"]) {
      session = {
        ...session,
        state: cacheTerminalTaskView(session.state, terminal(taskId, "completed")),
      };
    }
    session = recordSessionTask(session, task("task_c", "turn-3"));
    session = recordSessionTask(session, {
      ...task("task_a", "turn-replay"),
      createdByStepIndex: 9,
      taskRunId: "run-replayed",
    });
    session = recordSessionTask(session, {
      ...task("task_b", "turn-replay"),
      createdByStepIndex: 9,
    });
    expect(
      getSessionTaskIndex(session.state).map((entry) => ({
        taskId: entry.taskId,
        cohortId: getTaskCohortId(entry),
        turnId: entry.createdByTurnId,
        stepIndex: entry.createdByStepIndex,
        settled: entry.terminalView !== undefined,
      })),
    ).toEqual([
      { taskId: "task_a", cohortId: "task_a", turnId: "turn-1", stepIndex: 0, settled: true },
      { taskId: "task_b", cohortId: "task_a", turnId: "turn-2", stepIndex: 0, settled: true },
      { taskId: "task_c", cohortId: "task_c", turnId: "turn-3", stepIndex: 0, settled: false },
    ]);
    expect(findSessionTaskEntry(session.state, "task_a")?.taskRunId).toBe("run-replayed");
    session = recordSessionTask(session, task("task_d", "turn-4"));
    expect(findSessionTaskEntry(session.state, "task_d")?.cohortId).toBe("task_c");
  });

  it.each(["", null, 42])("rejects an invalid additive cohort identity: %j", (cohortId) => {
    expect(() =>
      getSessionTaskIndex({
        [SESSION_TASKS_STATE_KEY]: {
          tasks: [{ ...task("task_a", "turn-1"), cohortId }],
          version: 2,
        },
      }),
    ).toThrow(/Corrupt task index/u);
  });

  it("retains only terminal views as expired-run fallbacks", () => {
    const base = {
      taskInboxToken: "task:token-1",
      createdByTurnId: "turn-1",
      metadata,
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
            version: 2,
          },
        }),
      ).toThrow(`Corrupt task index under session state key "${SESSION_TASKS_STATE_KEY}"`);
    }
  });

  it("throws on a corrupt index instead of treating it as absent", () => {
    expect(() =>
      getSessionTaskIndex({
        [SESSION_TASKS_STATE_KEY]: { tasks: [{ taskId: 42 }], version: 2 },
      }),
    ).toThrow(`Corrupt task index under session state key "${SESSION_TASKS_STATE_KEY}"`);
  });

  it("rejects the old task index version explicitly", () => {
    expect(() =>
      getSessionTaskIndex({ [SESSION_TASKS_STATE_KEY]: { tasks: [], version: 1 } }),
    ).toThrow(
      `Unsupported task index version 1 under session state key "${SESSION_TASKS_STATE_KEY}"`,
    );
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
