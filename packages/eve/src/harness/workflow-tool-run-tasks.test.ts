import { assert, describe, expect, it } from "vitest";
import type { HarnessSession } from "#harness/types.js";
import {
  getBackgroundTasks,
  recordWorkflowTaskView,
  registerWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { deriveTaskId } from "#tasks/task-id.js";
import type { TaskView } from "#tasks/types.js";
import type { BackgroundTask } from "#harness/workflow-tool-runs.js";

function views(tasks: readonly BackgroundTask[]): TaskView[] {
  return tasks.map(({ cohortId: _cohortId, turnId: _turnId, run: _run, ...view }) => view);
}

function ids(tasks: readonly BackgroundTask[]): string[] {
  return tasks.map((task) => task.taskId);
}

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
  const dispatchContext = { auth: { current: null, initiator: null } } as const;
  it("returns an empty index when the key is absent", () => {
    expect(getBackgroundTasks({}).query()).toEqual([]);
    expect(getBackgroundTasks(undefined).query()).toEqual([]);
  });

  it("queries restored background tasks by state across turns, excluding blocking runs", () => {
    let session = registerWorkflowToolRun(createSession(), task("working", "turn-1"));
    for (const status of ["completed", "failed", "cancelled"] as const) {
      session = registerWorkflowToolRun(session, task(status, "turn-2"));
      session = {
        ...session,
        state: recordWorkflowTaskView(session.state, terminal(status, status)).state,
      };
    }
    session = registerWorkflowToolRun(session, {
      callId: "blocking",
      toolName: "research",
      lifetime: "turn",
      origin: { turnId: "turn-2", stepIndex: 0 },
      address: { runId: "blocking", hookToken: "blocking" },
    });

    const backgroundTasks = getBackgroundTasks(JSON.parse(JSON.stringify(session.state)));
    expect(views(backgroundTasks.query({ state: "working" }))).toEqual([
      { taskId: "working", metadata, status: "working" },
    ]);
    expect(views(backgroundTasks.query({ state: "completed" }))).toEqual([
      terminal("completed", "completed"),
    ]);
    expect(views(backgroundTasks.query({ state: "failed" }))).toEqual([
      terminal("failed", "failed"),
    ]);
    expect(views(backgroundTasks.query({ state: "cancelled" }))).toEqual([
      terminal("cancelled", "cancelled"),
    ]);
    expect(getBackgroundTasks(undefined).query({ state: "working" })).toEqual([]);
  });

  it("distinguishes a first terminal settlement from repeated and late reports", () => {
    const session = registerWorkflowToolRun(createSession(), task("task_a", "turn-1"));
    const completed = terminal("task_a", "completed");
    const first = recordWorkflowTaskView(session.state, completed);
    expect(first.firstOutcome).toBe(true);
    expect(first.view).toEqual(completed);

    const repeated = recordWorkflowTaskView(first.state, completed);
    expect(repeated.state).toBe(first.state);
    expect(repeated.firstOutcome).toBe(false);
    expect(repeated.view).toEqual(completed);

    const late = recordWorkflowTaskView(repeated.state, terminal("task_a", "cancelled"));
    expect(late.state).toBe(repeated.state);
    expect(late.firstOutcome).toBe(false);
    expect(late.view).toEqual(completed);
  });

  it("retains cancellation across restore and late outcomes without removing cohort membership", () => {
    const session = registerWorkflowToolRun(createSession(), task("task_a", "turn-1"));
    const state = recordWorkflowTaskView(session.state, terminal("task_a", "cancelled")).state;
    const replay = registerWorkflowToolRun(
      createSession(JSON.parse(JSON.stringify(state))),
      task("task_a", "turn-1"),
    );
    const late = recordWorkflowTaskView(replay.state, terminal("task_a", "completed")).state;
    expect(views(getBackgroundTasks(late).query({ state: "cancelled" }))).toEqual([
      terminal("task_a", "cancelled"),
    ]);
    expect(getBackgroundTasks(late).get("task_a")?.cohortId).toBe("task_a");
  });

  it("decodes only the tasks a read returns", () => {
    const retained = task("task_old", "turn-1");
    const tasks = getBackgroundTasks({
      "eve.workflowTool": {
        version: 3,
        runs: [
          { ...retained, task: { ...retained.task, outcome: { status: "completed" } } },
          task("task_live", "turn-2"),
        ],
      },
    });
    // A corrupt retained outcome must not block reads of unrelated work.
    expect(ids(tasks.query({ state: "working" }))).toEqual(["task_live"]);
    expect(tasks.get("task_live")?.status).toBe("working");
    expect(() => tasks.get("task_old")).toThrow("Corrupt workflow task result");
    expect(() => tasks.query({ state: "completed" })).toThrow("Corrupt workflow task result");
    expect(() => tasks.query()).toThrow("Corrupt workflow task result");
  });

  it("filters by starting turn, cohort, and a set of states", () => {
    let session = registerWorkflowToolRun(createSession(), task("task_a", "turn-1"));
    // Work started while task_a is open joins its cohort.
    session = registerWorkflowToolRun(session, task("task_b", "turn-2"));
    session = {
      ...session,
      state: recordWorkflowTaskView(session.state, terminal("task_a", "cancelled")).state,
    };
    const tasks = getBackgroundTasks(session.state);
    expect(ids(tasks.query({ turnId: "turn-2" }))).toEqual(["task_b"]);
    expect(ids(tasks.query({ cohortId: "task_a" }))).toEqual(["task_a", "task_b"]);
    expect(ids(tasks.query({ state: ["working", "cancelled"] }))).toEqual(["task_a", "task_b"]);
    expect(ids(tasks.query({ state: "working", turnId: "turn-1" }))).toEqual([]);
    expect(tasks.get("task_b")).toMatchObject({ cohortId: "task_a", turnId: "turn-2" });
  });

  it("records a task and finds it by id", () => {
    const session = registerWorkflowToolRun(createSession(), {
      callId: "task_a",
      toolName: metadata.name,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-1", hookToken: "task:token-1" },
      task: { dispatchContext, metadata, taskId: "task_a" },
    });

    expect(getBackgroundTasks(session.state).get("task_a")?.run).toEqual({
      callId: "task_a",
      toolName: metadata.name,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-1", hookToken: "task:token-1" },
      task: { dispatchContext, metadata, taskId: "task_a" },
    });
    expect(getBackgroundTasks(session.state).get("task_other")?.run).toBeUndefined();
  });

  it("keeps activity identity in the persisted task index", () => {
    const activityWorkIdentity = {
      callId: "call-1",
      id: "work:task",
      kind: "task" as const,
      name: "research",
      parentId: "work:root",
      rootSessionId: "root-session",
      rootTurnId: "root-turn",
    };
    const session = registerWorkflowToolRun(createSession(), {
      callId: "task_a",
      toolName: metadata.name,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-1", hookToken: "task:token-1" },
      task: { activityWorkIdentity, dispatchContext, metadata, taskId: "task_a" },
    });

    const restoredState = JSON.parse(JSON.stringify(session.state));
    expect(getBackgroundTasks(restoredState).get("task_a")?.run.task.activityWorkIdentity).toEqual(
      activityWorkIdentity,
    );
  });

  it("keeps subagent metadata in the persisted task index", () => {
    const subagentMetadata = {
      agentId: "ag_worker",
      kind: "subagent",
      mode: "remote",
      name: "research",
    } as const;

    const session = registerWorkflowToolRun(createSession(), {
      callId: "task_a",
      toolName: subagentMetadata.name,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-1", hookToken: "task:token-1" },
      task: { dispatchContext, metadata: subagentMetadata, taskId: "task_a" },
    });

    expect(getBackgroundTasks(session.state).get("task_a")?.run.task.metadata).toEqual(
      subagentMetadata,
    );
  });

  it("keeps a terminal view when replayed activity presentation changes", () => {
    let session = registerWorkflowToolRun(createSession(), {
      callId: "task_a",
      toolName: metadata.name,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-1", hookToken: "task:token-1" },
      task: {
        activityWorkIdentity: {
          callId: "call-1",
          id: "work:task",
          kind: "task",
          label: "First label",
          name: "research",
          parentId: "work:root",
          rootSessionId: "root-session",
          rootTurnId: "root-turn",
        },
        dispatchContext,
        metadata,
        taskId: "task_a",
      },
    });
    session = {
      ...session,
      state: recordWorkflowTaskView(session.state, terminal("task_a", "completed")).state,
    };
    session = registerWorkflowToolRun(session, {
      callId: "task_a",
      toolName: metadata.name,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-2", hookToken: "task:token-2" },
      task: {
        activityWorkIdentity: {
          callId: "call-1",
          id: "work:task",
          kind: "task",
          label: "Second label",
          name: "research",
          parentId: "work:root",
          rootSessionId: "root-session",
          rootTurnId: "root-turn",
        },
        dispatchContext,
        metadata,
        taskId: "task_a",
      },
    });

    expect(getBackgroundTasks(session.state).get("task_a")?.run).toMatchObject({
      task: {
        activityWorkIdentity: { label: "Second label" },
        outcome: { status: "completed", lastOutput: { type: "result", data: "done" } },
      },
    });
  });

  it("replaces the entry on replayed creation instead of duplicating it", () => {
    let session = registerWorkflowToolRun(createSession(), {
      callId: "task_a",
      toolName: metadata.name,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-1", hookToken: "task:token-1" },
      task: { dispatchContext, metadata, taskId: "task_a" },
    });
    session = registerWorkflowToolRun(session, {
      callId: "task_a",
      toolName: metadata.name,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-2", hookToken: "task:token-2" },
      task: { dispatchContext, metadata, taskId: "task_a" },
    });

    const entries = getBackgroundTasks(session.state)
      .query()
      .map((task) => task.run);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.address.runId).toBe("run-2");
  });

  function task(taskId: string, createdByTurnId: string) {
    return {
      callId: taskId,
      toolName: metadata.name,
      lifetime: "session" as const,
      origin: { turnId: createdByTurnId, stepIndex: 0 },
      address: { runId: `run-${taskId}`, hookToken: `inbox-${taskId}` },
      task: { dispatchContext, metadata, taskId },
    };
  }

  function terminal(taskId: string, status: "completed" | "failed" | "cancelled"): TaskView {
    if (status === "cancelled") return { metadata, status, taskId };
    return status === "completed"
      ? { metadata, status, taskId, lastOutput: { type: "result", data: "done" } }
      : { metadata, status, taskId, lastOutput: { type: "error", data: "failed" } };
  }

  it("durably joins overlapping work across turns", () => {
    const first = task("task_a", "turn-1");
    const initial = registerWorkflowToolRun(createSession(), first);
    const second = task("task_b", "turn-2");
    const session = registerWorkflowToolRun(initial, second);
    const tasks = getBackgroundTasks(session.state).query();
    expect(tasks.map((task) => task.cohortId)).toEqual(["task_a", "task_a"]);
    expect(tasks.map((task) => task.turnId)).toEqual(["turn-1", "turn-2"]);
    // A cohort's first task has no join target; later members store it.
    expect(tasks[0]?.run.task.cohortId).toBeUndefined();
    expect(tasks[1]?.run.task.cohortId).toBe("task_a");
    const restored = createSession(JSON.parse(JSON.stringify(initial.state)));
    expect(registerWorkflowToolRun(restored, second).state).toEqual(session.state);
    expect(getBackgroundTasks(initial.state).query()).toHaveLength(1);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "keeps a %s sibling in a pending cohort, then starts a new cohort after settlement",
    (status) => {
      let session = registerWorkflowToolRun(createSession(), task("task_a", "turn-1"));
      session = registerWorkflowToolRun(session, task("task_b", "turn-1"));
      session = {
        ...session,
        state: recordWorkflowTaskView(session.state, terminal("task_a", status)).state,
      };
      session = registerWorkflowToolRun(session, task("task_c", "turn-2"));
      expect(
        getBackgroundTasks(session.state)
          .query()
          .map((task) => task.cohortId),
      ).toEqual(["task_a", "task_a", "task_a"]);
      for (const taskId of ["task_b", "task_c"]) {
        session = {
          ...session,
          state: recordWorkflowTaskView(session.state, terminal(taskId, status)).state,
        };
      }
      // Even another creation in the same turn must not reopen a settled cohort.
      session = registerWorkflowToolRun(session, task("task_d", "turn-2"));
      expect(
        getBackgroundTasks(session.state)
          .query()
          .map((task) => task.cohortId),
      ).toEqual(["task_a", "task_a", "task_a", "task_d"]);
    },
  );

  it("preserves replayed membership, creation provenance, order, and settlement", () => {
    let session = registerWorkflowToolRun(createSession(), task("task_a", "turn-1"));
    session = registerWorkflowToolRun(session, task("task_b", "turn-2"));
    for (const taskId of ["task_a", "task_b"]) {
      session = {
        ...session,
        state: recordWorkflowTaskView(session.state, terminal(taskId, "completed")).state,
      };
    }
    session = registerWorkflowToolRun(session, task("task_c", "turn-3"));
    session = registerWorkflowToolRun(session, {
      ...task("task_a", "turn-1"),
      origin: { ...task("task_a", "turn-1").origin, stepIndex: 9 },
      address: { ...task("task_a", "turn-1").address, runId: "run-replayed" },
    });
    session = registerWorkflowToolRun(session, {
      ...task("task_b", "turn-2"),
      origin: { ...task("task_b", "turn-2").origin, stepIndex: 9 },
    });
    expect(
      getBackgroundTasks(session.state)
        .query()
        .map((task) => ({
          taskId: task.taskId,
          cohortId: task.cohortId,
          turnId: task.turnId,
          stepIndex: task.run.origin.stepIndex,
          settled: task.status !== "working",
        })),
    ).toEqual([
      { taskId: "task_a", cohortId: "task_a", turnId: "turn-1", stepIndex: 0, settled: true },
      { taskId: "task_b", cohortId: "task_a", turnId: "turn-2", stepIndex: 0, settled: true },
      { taskId: "task_c", cohortId: "task_c", turnId: "turn-3", stepIndex: 0, settled: false },
    ]);
    expect(getBackgroundTasks(session.state).get("task_a")?.run.address.runId).toBe("run-replayed");
    session = registerWorkflowToolRun(session, task("task_d", "turn-4"));
    expect(getBackgroundTasks(session.state).get("task_d")?.run.task.cohortId).toBe("task_c");
  });

  it.each(["", null, 42])("rejects an invalid additive cohort identity: %j", (cohortId) => {
    expect(() =>
      getBackgroundTasks({
        "eve.workflowTool": {
          version: 3,
          runs: [
            {
              ...task("task_a", "turn-1"),
              task: { ...task("task_a", "turn-1").task, cohortId: cohortId },
            },
          ],
        },
      }),
    ).toThrow(/Corrupt workflow tool run registry/u);
  });

  it("validates retained outcomes when they are consumed", () => {
    const base = {
      callId: "task_a",
      toolName: metadata.name,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-1", hookToken: "task:token-1" },
      task: { dispatchContext, metadata, taskId: "task_a" },
    };
    const outcome = {
      lastOutput: { data: "done", type: "result" as const },
      status: "completed" as const,
    };

    const session = registerWorkflowToolRun(createSession(), {
      ...base,
      task: { ...base.task, outcome },
    });
    expect(getBackgroundTasks(session.state).get("task_a")?.run.task.outcome).toEqual(outcome);
    for (const invalidOutcome of [
      { status: "working" },
      { status: "completed" },
      {
        lastOutput: { data: "wrong", type: "result" },
        status: "failed",
      },
      {
        lastOutput: { data: "wrong", type: "result" },
        status: "cancelled",
      },
      {
        inputRequests: [{ requestId: "stale" }],
        lastOutput: { data: "done", type: "result" },
        status: "completed",
      },
    ]) {
      const tasks = getBackgroundTasks({
        "eve.workflowTool": {
          version: 3,
          runs: [{ ...base, task: { ...base.task, outcome: invalidOutcome } }],
        },
      });
      // The registry keeps the entry; only reading its view rejects the outcome.
      expect(tasks.query({ state: "working" })).toEqual([]);
      expect(() => tasks.get(base.task.taskId)).toThrow("Corrupt workflow task result");
      expect(() =>
        registerWorkflowToolRun(createSession(), {
          ...base,
          task: { ...base.task, outcome: invalidOutcome },
        }),
      ).toThrow("Corrupt workflow task result");
    }
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "keeps the parent's first %s outcome across duplicates and competing deliveries",
    (status) => {
      const session = registerWorkflowToolRun(createSession(), task("task_a", "turn-1"));
      const usage = { inputTokens: 3, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const first = { ...terminal("task_a", status), usage };
      const state = recordWorkflowTaskView(session.state, first).state;
      for (const late of ["completed", "failed", "cancelled"] as const) {
        expect(recordWorkflowTaskView(state, terminal("task_a", late)).state).toBe(state);
      }
      const recorded = getBackgroundTasks(state).get("task_a");
      assert(recorded !== undefined);
      expect(recorded.run.task.outcome).toEqual(
        status === "cancelled"
          ? { status, usage }
          : { status, usage, lastOutput: first.lastOutput },
      );
      expect(views([recorded])).toEqual([first]);
    },
  );

  it("rejects an incoming result with metadata belonging to a different task", () => {
    const session = registerWorkflowToolRun(createSession(), task("task_a", "turn-1"));
    expect(
      () =>
        recordWorkflowTaskView(session.state, {
          ...terminal("task_a", "cancelled"),
          metadata: { kind: "tool", name: "other" },
        }).state,
    ).toThrow("Task view metadata does not match");
  });

  it("throws on a corrupt index instead of treating it as absent", () => {
    expect(() =>
      getBackgroundTasks({
        "eve.workflowTool": { version: 3, runs: [{ taskId: 42 }] },
      }),
    ).toThrow("Corrupt workflow tool run registry");
  });

  it("rejects missing creator context", () => {
    const entry = task("task_a", "turn-1");
    expect(() =>
      getBackgroundTasks({
        "eve.workflowTool": {
          version: 3,
          runs: [{ ...entry, task: { ...entry.task, dispatchContext: undefined } }],
        },
      }),
    ).toThrow("Corrupt workflow tool run registry");
  });

  it("rejects reassigning a task id to another originating turn", () => {
    const session = registerWorkflowToolRun(createSession(), task("task_a", "turn-1"));
    expect(() => registerWorkflowToolRun(session, task("task_a", "turn-2"))).toThrow(
      "Task ids must be unique",
    );
  });

  it("rejects unrecognized task dispatch context fields", () => {
    expect(() =>
      getBackgroundTasks({
        "eve.workflowTool": {
          version: 3,
          runs: [
            {
              callId: "task_a",
              toolName: metadata.name,
              lifetime: "session" as const,
              origin: { turnId: "turn-1", stepIndex: 0 },
              address: { runId: "run-1", hookToken: "task:token-1" },
              task: {
                dispatchContext: {
                  auth: { current: null, initiator: null },
                  unexpected: "receiver-context",
                },
                metadata,
                taskId: "task_a",
              },
            },
          ],
        },
      }),
    ).toThrow("Corrupt workflow tool run registry");
  });

  it("rejects an unsupported registry version", () => {
    expect(() =>
      getBackgroundTasks({
        "eve.workflowTool": { version: 99, runs: [] },
      }),
    ).toThrow("Corrupt workflow tool run registry");
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
