import { describe, expect, it } from "vitest";

import { getBackgroundWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { getTaskCohortId, getSessionTaskCohorts } from "#tasks/session-task-cohorts.js";

describe("workflow task cohort lookup", () => {
  it("projects the same identities as the full task index", () => {
    const state = {
      "eve.runtime.workflowInvocations": {
        version: 2,
        invocations: ["turn-1", "turn-2", "turn-2"].map((createdByTurnId, index) => ({
          callId: `task_${index}`,
          toolName: "worker",
          lifetime: "session" as const,
          origin: { turnId: createdByTurnId, stepIndex: 0 },
          address: { runId: `run-${index}`, hookToken: `inbox-${index}` },
          task: {
            cohortId: index === 1 ? "task_0" : undefined,
            taskId: `task_${index}`,
            dispatchContext: { auth: { current: null, initiator: null } },
            metadata: { kind: "subagent", name: "worker" },
          },
        })),
      },
    };
    expect([...getSessionTaskCohorts(state)]).toEqual(
      getBackgroundWorkflowToolRuns(state).map((task) => [
        task.task.taskId,
        getTaskCohortId(task.task),
      ]),
    );
  });

  it("returns no cohorts when the task index is absent", () => {
    expect(getSessionTaskCohorts(undefined).size).toBe(0);
    expect(getSessionTaskCohorts({}).size).toBe(0);
  });

  it.each([
    null,
    { version: 99, invocations: [] },
    { version: 1, invocations: null },
    { version: 1, invocations: [null] },
  ])("rejects invalid registry state: %j", (raw) => {
    expect(() => getSessionTaskCohorts({ "eve.runtime.workflowInvocations": raw })).toThrow(
      "Corrupt workflow invocation registry",
    );
  });
});
