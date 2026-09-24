import { describe, expect, it } from "vitest";

import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import {
  getTaskTable,
  isWorkflowTaskResult,
  isWorkingWorkflowTask,
  readTaskCallbackAlias,
  setTaskTable,
  TASK_CALLBACK_ALIAS_PREFIX,
  TASK_CALLBACK_ALIAS_STATE_KEY,
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
      { records: [working, idleAgent, neverStarted, awaitingConfirmation] },
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
  const from = { callId: "call-1", runId: "run-1", toolName: "deploy", turnId: "turn-1" };
  const working = createTaskRecord({
    child: run,
    id: "deploy-aaaaaa",
    kind: "workflow",
    name: "deploy",
  });

  it("finds the working task only for its own run, call, turn, and tool", () => {
    const session = { state: taskTableState([working]) };

    expect(isWorkingWorkflowTask(session, from)).toBe(true);
    expect(isWorkingWorkflowTask(session, { ...from, runId: "run-2" })).toBe(false);
    expect(isWorkingWorkflowTask(session, { ...from, callId: "call-2" })).toBe(false);
    expect(isWorkingWorkflowTask(session, { ...from, turnId: "turn-2" })).toBe(false);
    expect(isWorkingWorkflowTask(session, { ...from, toolName: "rollback" })).toBe(false);
  });

  it("does not treat a finished or cancelled task as working", () => {
    const cancelled = {
      ...working,
      cancelConfirmBy: "2026-09-24T14:00:30.000Z",
      status: "cancelled" as const,
    };

    expect(isWorkingWorkflowTask({ state: taskTableState([cancelled]) }, from)).toBe(false);
    expect(
      isWorkingWorkflowTask({ state: taskTableState([{ ...working, status: "completed" }]) }, from),
    ).toBe(false);
  });

  it("accepts an inbox tool result only for exactly one working task with that call and name", () => {
    const result = { callId: "call-1", toolName: "deploy" };
    const otherTurn = { ...working, id: "deploy-bbbbbb", turnId: "turn-0" };

    expect(isWorkflowTaskResult({ state: taskTableState([working]) }, result)).toBe(true);
    expect(
      isWorkflowTaskResult(
        { state: taskTableState([working]) },
        { ...result, toolName: "rollback" },
      ),
    ).toBe(false);
    expect(isWorkflowTaskResult({ state: taskTableState([working, otherTurn]) }, result)).toBe(
      false,
    );
    expect(
      isWorkflowTaskResult({ state: taskTableState([{ ...working, kind: "agent" }]) }, result),
    ).toBe(false);
    expect(isWorkflowTaskResult({ state: undefined }, result)).toBe(false);
  });
});
