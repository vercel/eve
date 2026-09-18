import { describe, expect, it } from "vitest";
import type { SessionStateMap } from "#harness/types.js";
import {
  readWorkflowTaskView,
  recordWorkflowTaskView,
  findBlockingWorkflowToolRun,
  getWorkflowToolRuns,
  registerWorkflowToolRun,
  removeBlockingWorkflowToolRuns,
  type BackgroundWorkflowToolRun,
  type BlockingWorkflowToolRun,
} from "./workflow-tool-runs.js";
import { getSessionTaskCohorts } from "#tasks/session-task-cohorts.js";
import { resolveTaskDeliveryContext } from "#tasks/delivery-context.js";

const waiting = (turnId: string): BlockingWorkflowToolRun => ({
  lifetime: "turn",
  callId: "same-call",
  toolName: "research",
  origin: { turnId, stepIndex: 0 },
  address: { runId: `run-${turnId}`, hookToken: `hook-${turnId}` },
});
const task = (taskId: string): BackgroundWorkflowToolRun => ({
  ...waiting("turn-a"),
  callId: taskId,
  lifetime: "session",
  address: { runId: `run-${taskId}`, hookToken: `hook-${taskId}` },
  task: {
    taskId,
    metadata: { kind: "tool", name: "research" },
    dispatchContext: { auth: { current: null, initiator: null } },
  },
});

describe("shared workflow invocation ownership", () => {
  it("clears only one turn while retaining another turn, live tasks and completed payloads", () => {
    let session: { state?: SessionStateMap } = registerWorkflowToolRun({}, waiting("turn-a"));
    session = registerWorkflowToolRun(session, waiting("turn-b"));
    session = registerWorkflowToolRun(session, task("task-a"));
    session = registerWorkflowToolRun(session, task("task-b"));
    session = {
      ...session,
      state: recordWorkflowTaskView(session.state, {
        taskId: "task-a",
        metadata: task("task-a").task.metadata,
        status: "completed",
        lastOutput: { type: "result", data: "first" },
      }),
    };
    session = removeBlockingWorkflowToolRuns(session, "turn-a");
    const entries = getWorkflowToolRuns(session.state);
    expect(entries.map((entry) => [entry.lifetime, entry.callId])).toEqual([
      ["turn", "same-call"],
      ["session", "task-a"],
      ["session", "task-b"],
    ]);
    expect(findBlockingWorkflowToolRun(session.state, "same-call", "turn-a")).toBeUndefined();
    expect(findBlockingWorkflowToolRun(session.state, "same-call", "turn-b")).toEqual(
      waiting("turn-b"),
    );
    expect(
      resolveTaskDeliveryContext({ state: session.state, taskDeliveryId: "task-a:ready:completed" })
        ?.phase,
    ).toBe("pending");
    session = {
      ...session,
      state: recordWorkflowTaskView(session.state, {
        taskId: "task-b",
        metadata: task("task-b").task.metadata,
        status: "failed",
        lastOutput: { type: "error", data: "second" },
      }),
    };
    const restored = JSON.parse(
      JSON.stringify(removeBlockingWorkflowToolRuns(session, "turn-b").state),
    );
    const beforeReport = JSON.stringify(restored);
    const report = resolveTaskDeliveryContext({
      state: restored,
      taskDeliveryId: "task-b:ready:failed",
    });
    expect(report?.phase).toBe("settled");
    expect(report?.context).toContain("first");
    expect(report?.context).toContain("second");
    expect([...getSessionTaskCohorts(restored).values()]).toEqual(["task-a", "task-a"]);
    expect(
      JSON.stringify(removeBlockingWorkflowToolRuns({ state: restored }, "turn-a").state),
    ).toBe(beforeReport);
  });

  it("preserves malformed historical results during unrelated ownership mutations", () => {
    const old = task("old");
    const retained = { ...old, task: { ...old.task, terminalView: { status: "completed" } } };
    let session: { state?: SessionStateMap } = {
      state: { "eve.runtime.workflowInvocations": { version: 2, invocations: [retained] } },
    };
    session = registerWorkflowToolRun(session, waiting("turn-b"));
    session = registerWorkflowToolRun(session, task("live"));
    session = {
      ...session,
      state: recordWorkflowTaskView(session.state, {
        taskId: "live",
        metadata: old.task.metadata,
        status: "cancelled",
      }),
    };
    session = removeBlockingWorkflowToolRuns(session, "turn-b");
    const entries = getWorkflowToolRuns(session.state);
    expect(entries[0]).toEqual(retained);
    expect(() => readWorkflowTaskView(retained.task)).toThrow("Corrupt workflow task result");
    expect(entries).toHaveLength(2);
  });

  it("retains creator auth and opaque selections without sharing parsed mutable containers", () => {
    const entry = task("task-a");
    const principal = {
      attributes: { roles: ["researcher"], team: "eve" },
      authenticator: "test",
      principalId: "alice",
      principalType: "user",
    };
    const selections = { researcher: { futureSelection: true } };
    const retained = {
      ...entry,
      task: {
        ...entry.task,
        dispatchContext: {
          auth: { current: principal, initiator: principal },
          sessionDynamicSubagentSelections: selections,
        },
      },
    };
    const [parsed] = getWorkflowToolRuns({
      "eve.runtime.workflowInvocations": { version: 2, invocations: [retained] },
    });
    expect(parsed).toEqual(retained);
    expect(parsed?.lifetime).toBe("session");
    if (parsed?.lifetime !== "session") throw new Error("Expected a background run.");
    const context = parsed.task.dispatchContext;
    expect(context.auth.current).not.toBe(principal);
    expect(context.auth.current?.attributes.roles).not.toBe(principal.attributes.roles);
    expect(Object.isFrozen(context.auth.current?.attributes.roles)).toBe(true);
    expect(context.sessionDynamicSubagentSelections).not.toBe(selections);
    expect(context.sessionDynamicSubagentSelections?.researcher).toBe(selections.researcher);
  });

  it.each([
    { auth: { current: null } },
    { auth: { current: null, initiator: null, injected: true } },
    {
      auth: {
        current: {
          attributes: { roles: Array(1) },
          authenticator: "test",
          principalId: "alice",
          principalType: "user",
        },
        initiator: null,
      },
    },
    {
      auth: {
        current: {
          attributes: { roles: ["researcher", 1] },
          authenticator: "test",
          principalId: "alice",
          principalType: "user",
        },
        initiator: null,
      },
    },
    {
      auth: {
        current: {
          attributes: {},
          authenticator: "test",
          principalId: "alice",
          principalType: "user",
          injected: true,
        },
        initiator: null,
      },
    },
    { auth: { current: null, initiator: null }, sessionDynamicSubagentSelections: [] },
  ])("rejects malformed retained creator authority: %j", (dispatchContext) => {
    const entry = task("task-a");
    expect(() =>
      getWorkflowToolRuns({
        "eve.runtime.workflowInvocations": {
          version: 2,
          invocations: [{ ...entry, task: { ...entry.task, dispatchContext } }],
        },
      }),
    ).toThrow("Corrupt workflow invocation registry");
  });

  it("rejects duplicate originating call identities even without task payloads", () => {
    expect(() =>
      getWorkflowToolRuns({
        "eve.runtime.workflowInvocations": {
          version: 2,
          invocations: [waiting("turn-a"), waiting("turn-a")],
        },
      }),
    ).toThrow("Invocation identities must be unique");
  });

  it.each([Infinity, NaN, -1, "0"])("rejects corrupt terminal usage %s", (costUsd) => {
    const entry = task("task-a");
    expect(() =>
      readWorkflowTaskView({
        ...entry.task,
        terminalView: {
          taskId: "task-a",
          metadata: entry.task.metadata,
          status: "completed",
          lastOutput: { type: "result", data: "done" },
          usage: {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            inputTokens: 1,
            outputTokens: 1,
            costUsd,
          },
        },
      }),
    ).toThrow("Corrupt workflow task result");
  });

  it("does not change lifetime on replay", () => {
    const session = registerWorkflowToolRun({}, waiting("turn-a"));
    expect(() =>
      registerWorkflowToolRun(session, { ...task("task-a"), callId: "same-call" }),
    ).toThrow("Replayed invocation changed its ownership");
  });

  it.each(["eve.tasks", "eve.runtime.workflowToolRuns"])("rejects old state under %s", (key) => {
    expect(() => getWorkflowToolRuns({ [key]: [] })).toThrow(
      "Unsupported workflow invocation state",
    );
  });
});
