import { describe, expect, it } from "vitest";

import { createTaskRecord } from "#internal/testing/task-records.js";
import {
  getTaskTable,
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
