import { describe, expect, it } from "vitest";

import { getSessionTaskIndex } from "#tasks/session-index.js";
import { getSessionTaskCohorts, SESSION_TASKS_STATE_KEY } from "#tasks/session-task-cohorts.js";

describe("workflow task cohort lookup", () => {
  it("projects the same identities as the full task index", () => {
    const state = {
      [SESSION_TASKS_STATE_KEY]: {
        version: 2,
        tasks: ["turn-1", "turn-1", "turn-2"].map((createdByTurnId, index) => ({
          taskId: `task_${index}`,
          taskRunId: `run-${index}`,
          taskInboxToken: `inbox-${index}`,
          createdByTurnId,
          metadata: { kind: "subagent", name: "worker" },
        })),
      },
    };
    expect([...getSessionTaskCohorts(state)]).toEqual(
      getSessionTaskIndex(state).map((task) => [task.taskId, task.createdByTurnId]),
    );
  });

  it("returns no cohorts when the task index is absent", () => {
    expect(getSessionTaskCohorts(undefined).size).toBe(0);
    expect(getSessionTaskCohorts({}).size).toBe(0);
  });

  it.each([
    null,
    { version: 1, tasks: [] },
    { version: 3, tasks: [] },
    { version: 2, tasks: null },
    { version: 2, tasks: [null] },
    { version: 2, tasks: [{ taskId: "", createdByTurnId: "turn-1" }] },
    { version: 2, tasks: [{ taskId: "task_1", createdByTurnId: "" }] },
    { version: 2, tasks: [{ taskId: "task_1", createdByTurnId: 1 }] },
    {
      version: 2,
      tasks: [
        { taskId: "task_1", createdByTurnId: "turn-1" },
        { taskId: "task_1", createdByTurnId: "turn-2" },
      ],
    },
  ])("rejects ambiguous or invalid cohort identities: %j", (raw) => {
    expect(() => getSessionTaskCohorts({ [SESSION_TASKS_STATE_KEY]: raw })).toThrow(/task index/u);
  });
});
