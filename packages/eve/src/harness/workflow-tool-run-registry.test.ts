import { runInNewContext } from "node:vm";
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
  it("stores blocking and background runs together under eve.workflowTool", () => {
    const blocking = waiting("turn-a");
    const background = task("task-a");
    const initial: { state?: SessionStateMap } = {};
    const session = registerWorkflowToolRun(registerWorkflowToolRun(initial, blocking), background);
    expect(session.state).toEqual({
      "eve.workflowTool": { version: 3, runs: [blocking, background] },
    });
  });

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
      resolveTaskDeliveryContext({
        state: session.state,
        taskDeliveryIds: ["task-a:ready:completed"],
        taskDeliveryPolicy: "cohort",
      })?.phase,
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
      taskDeliveryIds: ["task-b:ready:failed"],
      taskDeliveryPolicy: "cohort",
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
    const retained = { ...old, task: { ...old.task, outcome: { status: "completed" } } };
    let session: { state?: SessionStateMap } = {
      state: { "eve.workflowTool": { version: 3, runs: [retained] } },
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
      "eve.workflowTool": { version: 3, runs: [retained] },
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

  it("reads creator auth and dynamic selections restored in the workflow VM", () => {
    const entry = task("task-a");
    const state = {
      "eve.workflowTool": {
        version: 3,
        runs: [
          {
            ...entry,
            task: {
              ...entry.task,
              dispatchContext: {
                auth: {
                  current: {
                    attributes: { roles: ["researcher"] },
                    authenticator: "test",
                    principalId: "alice",
                    principalType: "user",
                  },
                  initiator: null,
                },
                sessionDynamicSubagentSelections: { researcher: { futureSelection: true } },
                turnDynamicSubagentSelections: {},
              },
            },
          },
        ],
      },
    };
    const restored = runInNewContext("JSON.parse(input)", { input: JSON.stringify(state) });
    expect(Object.getPrototypeOf(restored)).not.toBe(Object.prototype);
    expect(getWorkflowToolRuns(restored)).toEqual(state["eve.workflowTool"].runs);
    expect(() => registerWorkflowToolRun({ state: restored }, waiting("turn-b"))).not.toThrow();
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
        "eve.workflowTool": {
          version: 3,
          runs: [{ ...entry, task: { ...entry.task, dispatchContext } }],
        },
      }),
    ).toThrow("Corrupt workflow tool run registry");
  });

  it("rejects duplicate originating call identities even without task payloads", () => {
    expect(() =>
      getWorkflowToolRuns({
        "eve.workflowTool": {
          version: 3,
          runs: [waiting("turn-a"), waiting("turn-a")],
        },
      }),
    ).toThrow("Run identities must be unique");
  });

  it.each([Infinity, NaN, -1, "0"])("rejects corrupt terminal usage %s", (costUsd) => {
    const entry = task("task-a");
    expect(() =>
      readWorkflowTaskView({
        ...entry.task,
        outcome: {
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

  it("rejects the task-only index from main", () => {
    expect(() => getWorkflowToolRuns({ "eve.tasks": { version: 2, tasks: [] } })).toThrow(
      "Unsupported workflow tool run state",
    );
  });

  it("rejects the separate blocking-run store from main", () => {
    expect(() => getWorkflowToolRuns({ "eve.runtime.workflowToolRuns": [] })).toThrow(
      "Unsupported workflow tool run state",
    );
  });
});
