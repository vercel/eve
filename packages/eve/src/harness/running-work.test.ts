import { describe, expect, it } from "vitest";

import { readRunningWork, writeRunningWork } from "#harness/running-work.js";

const call = { callId: "call_1" };
const task = { taskId: "task_1" };

describe("writeRunningWork", () => {
  it("keeps the calls when it writes the tasks, and the tasks when it writes the calls", () => {
    const withCalls = writeRunningWork({ "app.counter": 1 }, { calls: [call] });
    const withBoth = writeRunningWork(withCalls, { tasks: [task] });
    expect(readRunningWork(withBoth)).toEqual({ calls: [call], tasks: [task] });

    const replaced = writeRunningWork(withBoth, { calls: [{ callId: "call_2" }] });
    expect(readRunningWork(replaced)).toEqual({ calls: [{ callId: "call_2" }], tasks: [task] });
    expect(replaced?.["app.counter"]).toBe(1);
  });

  it("clears one part without the other, and drops the record once both are empty", () => {
    const both = writeRunningWork(undefined, { calls: [call], tasks: [task] });

    const tasksOnly = writeRunningWork(both, { calls: [] });
    expect(tasksOnly).toEqual({ "eve.work": { version: 1, tasks: [task] } });

    expect(writeRunningWork(tasksOnly, { tasks: [] })).toBeUndefined();
    expect(writeRunningWork({ "app.counter": 1, ...tasksOnly }, { tasks: [] })).toEqual({
      "app.counter": 1,
    });
  });
});
