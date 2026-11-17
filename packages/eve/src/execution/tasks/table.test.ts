import { describe, expect, it } from "vitest";

import {
  cancelTask,
  createProgramTask,
  findTask,
  isTaskWorking,
  programTaskId,
  settleTaskCalls,
} from "#execution/tasks/table.js";

describe("a program's task", () => {
  const program = { callId: "call-program", name: "eve__execute", turnId: "turn_0" };

  it("is named for the program's call, so a step that runs again names the same task", () => {
    const first = createProgramTask({ tasks: [] }, program);
    const again = createProgramTask(first.table, program);

    expect(first.taskId).toMatch(/^program-[0-9a-z]{6}$/u);
    expect(first.taskId).toBe(programTaskId("call-program"));
    expect(programTaskId("call-other")).not.toBe(first.taskId);
    // The record is there once, however many times the step runs.
    expect(again).toEqual(first);
    expect(first.table.tasks).toEqual([
      {
        calls: [{ callId: "call-program", turnId: "turn_0" }],
        id: first.taskId,
        kind: "tool",
        name: "eve__execute",
        program: true,
        results: [],
        resumable: false,
      },
    ]);
  });

  it("settles its call when cancelled, though no run does its work", () => {
    const { table, taskId } = createProgramTask({ tasks: [] }, program);

    const cancelled = cancelTask(table, taskId);

    expect(cancelled.settled).toEqual([{ callId: "call-program", turnId: "turn_0" }]);
    expect(cancelled.send).toBeUndefined();
    expect(isTaskWorking(findTask(cancelled.table, taskId)!)).toBe(false);
  });

  it("holds the program's result for the model until a step delivers it", () => {
    const { table, taskId } = createProgramTask({ tasks: [] }, program);

    const settled = settleTaskCalls(table, {
      callIds: ["call-program"],
      outcome: { output: { calls: { completed: 1 }, result: "done" }, status: "completed" },
      taskId,
    });

    expect(findTask(settled.table, taskId)).toMatchObject({
      calls: [],
      results: [{ output: { calls: { completed: 1 }, result: "done" }, status: "completed" }],
    });
  });
});
