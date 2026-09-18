import { describe, expect, it } from "vitest";
import type { SessionStateMap } from "#harness/types.js";
import {
  readWorkflowTaskView,
  recordWorkflowTaskView,
  findTurnInvocation,
  getWorkflowInvocations,
  registerWorkflowInvocation,
  removeTurnInvocations,
  type TaskWorkflowInvocation,
  type TurnWorkflowInvocation,
} from "./workflow-invocations.js";
import { getSessionTaskCohorts } from "#tasks/session-task-cohorts.js";
import { resolveTaskDeliveryContext } from "#tasks/delivery-context.js";

const waiting = (turnId: string): TurnWorkflowInvocation => ({
  lifetime: "turn",
  callId: "same-call",
  toolName: "research",
  resultKind: "tool",
  origin: { turnId, stepIndex: 0 },
  address: { runId: `run-${turnId}`, hookToken: `hook-${turnId}` },
});
const task = (taskId: string): TaskWorkflowInvocation => ({
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
    let session: { state?: SessionStateMap } = registerWorkflowInvocation({}, waiting("turn-a"));
    session = registerWorkflowInvocation(session, waiting("turn-b"));
    session = registerWorkflowInvocation(session, task("task-a"));
    session = registerWorkflowInvocation(session, task("task-b"));
    session = {
      ...session,
      state: recordWorkflowTaskView(session.state, {
        taskId: "task-a",
        metadata: task("task-a").task.metadata,
        status: "completed",
        lastOutput: { type: "result", data: "first" },
      }),
    };
    session = removeTurnInvocations(session, "turn-a");
    const entries = getWorkflowInvocations(session.state);
    expect(entries.map((entry) => [entry.lifetime, entry.callId])).toEqual([
      ["turn", "same-call"],
      ["session", "task-a"],
      ["session", "task-b"],
    ]);
    expect(findTurnInvocation(session.state, "turn-a", "same-call")).toBeUndefined();
    expect(findTurnInvocation(session.state, "turn-b", "same-call")).toEqual(waiting("turn-b"));
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
    const restored = JSON.parse(JSON.stringify(removeTurnInvocations(session, "turn-b").state));
    const beforeReport = JSON.stringify(restored);
    const report = resolveTaskDeliveryContext({
      state: restored,
      taskDeliveryId: "task-b:ready:failed",
    });
    expect(report?.phase).toBe("settled");
    expect(report?.context).toContain("first");
    expect(report?.context).toContain("second");
    expect([...getSessionTaskCohorts(restored).values()]).toEqual(["task-a", "task-a"]);
    expect(JSON.stringify(removeTurnInvocations({ state: restored }, "turn-a").state)).toBe(
      beforeReport,
    );
  });

  it("preserves malformed historical results during unrelated ownership mutations", () => {
    const old = task("old");
    const retained = { ...old, task: { ...old.task, terminalView: { status: "completed" } } };
    let session: { state?: SessionStateMap } = {
      state: { "eve.runtime.workflowInvocations": { version: 1, invocations: [retained] } },
    };
    session = registerWorkflowInvocation(session, waiting("turn-b"));
    session = registerWorkflowInvocation(session, task("live"));
    session = {
      ...session,
      state: recordWorkflowTaskView(session.state, {
        taskId: "live",
        metadata: old.task.metadata,
        status: "cancelled",
      }),
    };
    session = removeTurnInvocations(session, "turn-b");
    const entries = getWorkflowInvocations(session.state);
    expect(entries[0]).toEqual(retained);
    expect(() => readWorkflowTaskView(retained.task)).toThrow("Corrupt workflow task result");
    expect(entries).toHaveLength(2);
  });

  it("does not change lifetime on replay", () => {
    const session = registerWorkflowInvocation({}, waiting("turn-a"));
    expect(() =>
      registerWorkflowInvocation(session, { ...task("task-a"), callId: "same-call" }),
    ).toThrow("Replayed invocation changed its ownership");
  });

  it.each(["eve.tasks", "eve.runtime.workflowToolRuns"])("rejects old state under %s", (key) => {
    expect(() => getWorkflowInvocations({ [key]: [] })).toThrow(
      "Unsupported workflow invocation state",
    );
  });
});
