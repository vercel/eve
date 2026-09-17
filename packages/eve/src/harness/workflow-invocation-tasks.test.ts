import { assert, describe, expect, it } from "vitest";
import type { HarnessSession } from "#harness/types.js";
import {
  readWorkflowTaskView,
  cacheWorkflowTaskView,
  findTaskInvocation,
  getTaskInvocations,
  registerWorkflowInvocation,
} from "#harness/workflow-invocations.js";
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
  const dispatchContext = { auth: { current: null, initiator: null } } as const;
  it("returns an empty index when the key is absent", () => {
    expect(getTaskInvocations({})).toEqual([]);
    expect(getTaskInvocations(undefined)).toEqual([]);
  });

  it("records a task and finds it by id", () => {
    const session = registerWorkflowInvocation(createSession(), {
      callId: "task_a",
      toolName: metadata.name,
      resultKind: "tool" as const,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-1", hookToken: "task:token-1" },
      task: { dispatchContext, metadata, taskId: "task_a" },
    });

    expect(findTaskInvocation(session.state, "task_a")).toEqual({
      callId: "task_a",
      toolName: metadata.name,
      resultKind: "tool" as const,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-1", hookToken: "task:token-1" },
      task: { dispatchContext, metadata, taskId: "task_a" },
    });
    expect(findTaskInvocation(session.state, "task_other")).toBeUndefined();
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
    const session = registerWorkflowInvocation(createSession(), {
      callId: "task_a",
      toolName: metadata.name,
      resultKind: "tool" as const,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-1", hookToken: "task:token-1" },
      task: { activityWorkIdentity, dispatchContext, metadata, taskId: "task_a" },
    });

    const restoredState = JSON.parse(JSON.stringify(session.state));
    expect(findTaskInvocation(restoredState, "task_a")?.task.activityWorkIdentity).toEqual(
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

    const session = registerWorkflowInvocation(createSession(), {
      callId: "task_a",
      toolName: subagentMetadata.name,
      resultKind: "tool" as const,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-1", hookToken: "task:token-1" },
      task: { dispatchContext, metadata: subagentMetadata, taskId: "task_a" },
    });

    expect(findTaskInvocation(session.state, "task_a")?.task.metadata).toEqual(subagentMetadata);
  });

  it("keeps a terminal view when replayed activity presentation changes", () => {
    let session = registerWorkflowInvocation(createSession(), {
      callId: "task_a",
      toolName: metadata.name,
      resultKind: "tool" as const,
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
      state: cacheWorkflowTaskView(session.state, terminal("task_a", "completed")),
    };
    session = registerWorkflowInvocation(session, {
      callId: "task_a",
      toolName: metadata.name,
      resultKind: "tool" as const,
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

    expect(findTaskInvocation(session.state, "task_a")).toMatchObject({
      task: {
        activityWorkIdentity: { label: "Second label" },
        terminalView: terminal("task_a", "completed"),
      },
    });
  });

  it("replaces the entry on replayed creation instead of duplicating it", () => {
    let session = registerWorkflowInvocation(createSession(), {
      callId: "task_a",
      toolName: metadata.name,
      resultKind: "tool" as const,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-1", hookToken: "task:token-1" },
      task: { dispatchContext, metadata, taskId: "task_a" },
    });
    session = registerWorkflowInvocation(session, {
      callId: "task_a",
      toolName: metadata.name,
      resultKind: "tool" as const,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-2", hookToken: "task:token-2" },
      task: { dispatchContext, metadata, taskId: "task_a" },
    });

    const entries = getTaskInvocations(session.state);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.address.runId).toBe("run-2");
  });

  function task(taskId: string, createdByTurnId: string) {
    return {
      callId: taskId,
      toolName: metadata.name,
      resultKind: "tool" as const,
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
    const initial = registerWorkflowInvocation(createSession(), first);
    const second = task("task_b", "turn-2");
    const session = registerWorkflowInvocation(initial, second);
    const entries = getTaskInvocations(session.state);
    expect(entries.map((entry) => getTaskCohortId(entry.task))).toEqual(["task_a", "task_a"]);
    expect(entries.map((entry) => entry.origin.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(entries[0]?.task.cohortId).toBeUndefined();
    expect(entries[1]?.task.cohortId).toBe("task_a");
    const restored = createSession(JSON.parse(JSON.stringify(initial.state)));
    expect(registerWorkflowInvocation(restored, second).state).toEqual(session.state);
    expect(getTaskInvocations(initial.state)).toHaveLength(1);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "keeps a %s sibling in a pending cohort, then starts a new cohort after settlement",
    (status) => {
      let session = registerWorkflowInvocation(createSession(), task("task_a", "turn-1"));
      session = registerWorkflowInvocation(session, task("task_b", "turn-1"));
      session = {
        ...session,
        state: cacheWorkflowTaskView(session.state, terminal("task_a", status)),
      };
      session = registerWorkflowInvocation(session, task("task_c", "turn-2"));
      expect(getTaskInvocations(session.state).map((entry) => getTaskCohortId(entry.task))).toEqual(
        ["task_a", "task_a", "task_a"],
      );
      expect([...getSessionTaskCohorts(session.state).values()]).toEqual([
        { cohortId: "task_a", settled: true },
        { cohortId: "task_a", settled: false },
        { cohortId: "task_a", settled: false },
      ]);
      for (const taskId of ["task_b", "task_c"]) {
        session = {
          ...session,
          state: cacheWorkflowTaskView(session.state, terminal(taskId, status)),
        };
      }
      // Even another creation in the same turn must not reopen a settled cohort.
      session = registerWorkflowInvocation(session, task("task_d", "turn-2"));
      expect(getTaskInvocations(session.state).map((entry) => getTaskCohortId(entry.task))).toEqual(
        ["task_a", "task_a", "task_a", "task_d"],
      );
    },
  );

  it("preserves replayed membership, creation provenance, order, and settlement", () => {
    let session = registerWorkflowInvocation(createSession(), task("task_a", "turn-1"));
    session = registerWorkflowInvocation(session, task("task_b", "turn-2"));
    for (const taskId of ["task_a", "task_b"]) {
      session = {
        ...session,
        state: cacheWorkflowTaskView(session.state, terminal(taskId, "completed")),
      };
    }
    session = registerWorkflowInvocation(session, task("task_c", "turn-3"));
    session = registerWorkflowInvocation(session, {
      ...task("task_a", "turn-1"),
      origin: { ...task("task_a", "turn-1").origin, stepIndex: 9 },
      address: { ...task("task_a", "turn-1").address, runId: "run-replayed" },
    });
    session = registerWorkflowInvocation(session, {
      ...task("task_b", "turn-2"),
      origin: { ...task("task_b", "turn-2").origin, stepIndex: 9 },
    });
    expect(
      getTaskInvocations(session.state).map((entry) => ({
        taskId: entry.task.taskId,
        cohortId: getTaskCohortId(entry.task),
        turnId: entry.origin.turnId,
        stepIndex: entry.origin.stepIndex,
        settled: entry.task.terminalView !== undefined,
      })),
    ).toEqual([
      { taskId: "task_a", cohortId: "task_a", turnId: "turn-1", stepIndex: 0, settled: true },
      { taskId: "task_b", cohortId: "task_a", turnId: "turn-2", stepIndex: 0, settled: true },
      { taskId: "task_c", cohortId: "task_c", turnId: "turn-3", stepIndex: 0, settled: false },
    ]);
    expect(findTaskInvocation(session.state, "task_a")?.address.runId).toBe("run-replayed");
    session = registerWorkflowInvocation(session, task("task_d", "turn-4"));
    expect(findTaskInvocation(session.state, "task_d")?.task.cohortId).toBe("task_c");
  });

  it.each(["", null, 42])("rejects an invalid additive cohort identity: %j", (cohortId) => {
    expect(() =>
      getTaskInvocations({
        "eve.runtime.workflowInvocations": {
          version: 1,
          invocations: [
            {
              ...task("task_a", "turn-1"),
              task: { ...task("task_a", "turn-1").task, cohortId: cohortId },
            },
          ],
        },
      }),
    ).toThrow(/Corrupt workflow invocation registry/u);
  });

  it("retains only terminal views as expired-run fallbacks", () => {
    const base = {
      callId: "task_a",
      toolName: metadata.name,
      resultKind: "tool" as const,
      lifetime: "session" as const,
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: "run-1", hookToken: "task:token-1" },
      task: { dispatchContext, metadata, taskId: "task_a" },
    };
    const terminalView = {
      lastOutput: { data: "done", type: "result" as const },
      metadata,
      status: "completed" as const,
      taskId: "task_a",
    };

    const session = registerWorkflowInvocation(createSession(), {
      ...base,
      task: { ...base.task, terminalView: terminalView },
    });
    expect(findTaskInvocation(session.state, "task_a")?.task.terminalView).toEqual(terminalView);
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
      const [entry] = getTaskInvocations({
        "eve.runtime.workflowInvocations": {
          version: 1,
          invocations: [{ ...base, task: { ...base.task, terminalView: invalidView } }],
        },
      });
      expect(entry?.address).toEqual(base.address);
      assert(entry !== undefined);
      expect(() => readWorkflowTaskView(entry.task)).toThrow("Corrupt workflow task result");
      expect(() =>
        registerWorkflowInvocation(createSession(), {
          ...base,
          task: { ...base.task, terminalView: invalidView },
        }),
      ).toThrow("Corrupt workflow task result");
    }
  });

  it("throws on a corrupt index instead of treating it as absent", () => {
    expect(() =>
      getTaskInvocations({
        "eve.runtime.workflowInvocations": { version: 1, invocations: [{ taskId: 42 }] },
      }),
    ).toThrow("Corrupt workflow invocation registry");
  });

  it("rejects missing creator context", () => {
    const entry = task("task_a", "turn-1");
    expect(() =>
      getTaskInvocations({
        "eve.runtime.workflowInvocations": {
          version: 1,
          invocations: [{ ...entry, task: { ...entry.task, dispatchContext: undefined } }],
        },
      }),
    ).toThrow("Corrupt workflow invocation registry");
  });

  it("rejects reassigning a task id to another originating turn", () => {
    const session = registerWorkflowInvocation(createSession(), task("task_a", "turn-1"));
    expect(() => registerWorkflowInvocation(session, task("task_a", "turn-2"))).toThrow(
      "Task ids must be unique",
    );
  });

  it("rejects unrecognized task dispatch context fields", () => {
    expect(() =>
      getTaskInvocations({
        "eve.runtime.workflowInvocations": {
          version: 1,
          invocations: [
            {
              callId: "task_a",
              toolName: metadata.name,
              resultKind: "tool" as const,
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
    ).toThrow("Corrupt workflow invocation registry");
  });

  it("rejects an unsupported registry version", () => {
    expect(() =>
      getTaskInvocations({ "eve.runtime.workflowInvocations": { version: 99, invocations: [] } }),
    ).toThrow("Corrupt workflow invocation registry");
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
