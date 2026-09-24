import { describe, expect, it } from "vitest";

import { taskTable, createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import {
  findWorkflowTask,
  getTaskTable,
  planTaskTimer,
  readTaskCallbackAlias,
  readTaskTimer,
  setTaskTable,
  TASK_CALLBACK_ALIAS_PREFIX,
  TASK_CALLBACK_ALIAS_STATE_KEY,
  writeTaskTimer,
} from "#tasks/state.js";

const localChild = { continuationToken: "child-token", kind: "local" as const, sessionId: "child" };

describe("setTaskTable", () => {
  it("drops records nothing will read again on every write", () => {
    const working = createTaskRecord({ id: "research-aaaaaa" });
    const idleAgent = createTaskRecord({
      child: localChild,
      delivered: true,
      id: "research-bbbbbb",
      status: "completed",
    });
    const neverStarted = createTaskRecord({
      delivered: true,
      id: "research-cccccc",
      status: "failed",
    });
    const awaitingConfirmation = createTaskRecord({
      cancelConfirmBy: "2026-09-24T14:02:30.000Z",
      delivered: true,
      id: "research-dddddd",
      status: "cancelled",
    });

    const session = setTaskTable(
      { state: undefined },
      taskTable([working, idleAgent, neverStarted, awaitingConfirmation]),
    );

    expect(getTaskTable(session).records).toEqual([working, idleAgent, awaitingConfirmation]);
  });
});

describe("readTaskCallbackAlias", () => {
  it.each([
    [
      `${TASK_CALLBACK_ALIAS_PREFIX}${"ab".repeat(24)}`,
      `${TASK_CALLBACK_ALIAS_PREFIX}${"ab".repeat(24)}`,
    ],
    ["task-callback:legacy", undefined],
    [42, undefined],
  ])("reads %j as %j", (value, expected) => {
    expect(readTaskCallbackAlias({ [TASK_CALLBACK_ALIAS_STATE_KEY]: value })).toBe(expected);
  });
});

describe("workflow task lookups", () => {
  const run = { commandToken: "control", kind: "workflow" as const, runId: "run-1" };
  const from = { callId: "call-1", taskId: "deploy-aaaaaa", toolName: "deploy", turnId: "turn-1" };
  const working = createTaskRecord({
    child: run,
    id: "deploy-aaaaaa",
    kind: "workflow",
    name: "deploy",
  });

  it("finds the task only for its own task, call, turn, and tool", () => {
    const table = taskTable([working]);

    expect(findWorkflowTask(table, from)).toEqual(working);
    expect(findWorkflowTask(table, { ...from, taskId: "deploy-bbbbbb" })).toBeUndefined();
    expect(findWorkflowTask(table, { ...from, callId: "call-2" })).toBeUndefined();
    expect(findWorkflowTask(table, { ...from, turnId: "turn-2" })).toBeUndefined();
    expect(findWorkflowTask(table, { ...from, toolName: "rollback" })).toBeUndefined();
  });

  it("matches any run of the task: only the run holding its command hook reports", () => {
    // A retried start recorded the duplicate run; the first run claimed the hook.
    const table = taskTable([{ ...working, child: { ...run, runId: "run-duplicate" } }]);

    expect(findWorkflowTask(table, from)?.id).toBe("deploy-aaaaaa");
  });

  it("keeps matching a stopped task until its run confirms, and not after", () => {
    const cancelled = {
      ...working,
      cancelConfirmBy: "2026-09-24T14:00:30.000Z",
      status: "cancelled" as const,
    };

    expect(findWorkflowTask(taskTable([cancelled]), from)?.status).toBe("cancelled");
    expect(
      findWorkflowTask(taskTable([{ ...working, status: "completed" as const }]), from),
    ).toBeUndefined();
  });
});

describe("task timer state", () => {
  const DEADLINE = "2026-09-24T14:00:00.000Z";
  const BEFORE = Date.parse("2026-09-24T12:00:00.000Z");
  const current = { nowMs: BEFORE, ownerRunId: "owner-1" };
  const armedAt = (wakeAt: string, ownerRunId = "owner-1") => ({
    ownerRunId,
    runId: "timer-1",
    wakeAt,
  });

  it("round-trips the armed timer and removes the key when cleared", () => {
    const armed = armedAt(DEADLINE);
    const state = writeTaskTimer({ other: 1 }, armed);
    expect(readTaskTimer(state)).toEqual(armed);
    expect(writeTaskTimer(state, undefined)).toEqual({ other: 1 });
    expect(readTaskTimer({ "eve.taskTimer": { ...armed, wakeAt: "soon" } })).toBeUndefined();
    // A timer recorded without its owner run is re-armed.
    expect(readTaskTimer({ "eve.taskTimer": { runId: "timer-1", wakeAt: DEADLINE } })).toBe(
      undefined,
    );
  });

  it("arms only when the table needs a wake earlier than this owner's timer", () => {
    const table = taskTableState([createTaskRecord({ deadlineAt: DEADLINE })]);
    expect(planTaskTimer(table, current)).toEqual({ kind: "arm", wakeAt: DEADLINE });
    expect(
      planTaskTimer(writeTaskTimer(table, armedAt("2026-09-24T13:00:00.000Z")), current),
    ).toEqual({ kind: "keep" });
    expect(
      planTaskTimer(writeTaskTimer(table, armedAt("2026-09-24T15:00:00.000Z")), current),
    ).toEqual({ kind: "arm", wakeAt: DEADLINE });
    expect(planTaskTimer(taskTableState([createTaskRecord()]), current)).toEqual({
      kind: "keep",
    });
  });

  it("re-arms a timer another owner run armed", () => {
    const table = taskTableState([createTaskRecord({ deadlineAt: DEADLINE })]);
    const inherited = writeTaskTimer(table, armedAt("2026-09-24T13:00:00.000Z", "owner-0"));

    expect(planTaskTimer(inherited, current)).toEqual({ kind: "arm", wakeAt: DEADLINE });
  });

  it("treats a timer overdue past the grace period as lost and arms for now", () => {
    const table = writeTaskTimer(
      taskTableState([createTaskRecord({ deadlineAt: DEADLINE })]),
      armedAt(DEADLINE),
    );
    const withinGrace = { ...current, nowMs: Date.parse(DEADLINE) + 59_000 };
    const overdue = { ...current, nowMs: Date.parse(DEADLINE) + 61_000 };

    expect(planTaskTimer(table, withinGrace)).toEqual({ kind: "keep" });
    expect(planTaskTimer(table, overdue)).toEqual({
      kind: "arm",
      wakeAt: new Date(overdue.nowMs).toISOString(),
    });
  });

  it("cancels the armed timer once nothing is due", () => {
    const settled = writeTaskTimer(
      taskTableState([createTaskRecord({ status: "completed" })]),
      armedAt(DEADLINE),
    );

    expect(planTaskTimer(settled, current)).toEqual({ kind: "cancel" });
  });

  it("wakes at once for an unreadable record so the next write removes it", () => {
    expect(planTaskTimer({ "eve.taskTable": { records: [{ v: 0 }] } }, current)).toEqual({
      kind: "arm",
      wakeAt: new Date(BEFORE).toISOString(),
    });
  });
});
