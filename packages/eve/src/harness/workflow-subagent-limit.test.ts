import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKFLOW_MAX_SUBAGENTS,
  planWorkflowSubagentDispatch,
} from "#harness/workflow-subagent-limit.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";

function createTask(index: number): RuntimeWorkflowTaskRequest {
  return {
    callId: `call-${index}`,
    input: {},
    kind: "workflow-task",
    resultKind: "subagent",
    toolName: "echo-marker",
    workflowId: "workflow//./agent/subagents/researcher//execute",
  };
}

describe("planWorkflowSubagentDispatch", () => {
  it("allows every pending action while the budget holds", () => {
    const tasks = [createTask(1), createTask(2)];
    const plan = planWorkflowSubagentDispatch({
      tasks,
      maxSubagents: 3,
      usedCalls: 0,
    });

    expect(plan.allowed).toEqual(tasks);
    expect(plan.blocked).toEqual([]);
    expect(plan.usedCalls).toBe(0);
  });

  it("blocks tasks beyond the remaining budget while preserving order", () => {
    const tasks = [createTask(1), createTask(2), createTask(3)];
    const plan = planWorkflowSubagentDispatch({
      tasks,
      maxSubagents: 3,
      usedCalls: 1,
    });

    expect(plan.allowed).toEqual([tasks[0], tasks[1]]);
    expect(plan.blocked).toEqual([tasks[2]]);
    expect(plan.usedCalls).toBe(1);
  });

  it("does not charge ordinary workflow tasks against the subagent budget", () => {
    const toolTask = { ...createTask(2), resultKind: "tool" as const };
    const tasks = [createTask(1), toolTask, createTask(3)];

    const plan = planWorkflowSubagentDispatch({ tasks, maxSubagents: 1, usedCalls: 0 });

    expect(plan.allowed).toEqual([tasks[0], toolTask]);
    expect(plan.blocked).toEqual([tasks[2]]);
  });

  it("blocks everything once the persisted budget is spent", () => {
    const plan = planWorkflowSubagentDispatch({
      tasks: [createTask(1)],
      maxSubagents: 2,
      usedCalls: 2,
    });

    expect(plan.allowed).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
  });

  it("defaults the budget to DEFAULT_WORKFLOW_MAX_SUBAGENTS", () => {
    const plan = planWorkflowSubagentDispatch({
      tasks: [createTask(1)],
      usedCalls: 0,
    });

    expect(plan.maxSubagents).toBe(DEFAULT_WORKFLOW_MAX_SUBAGENTS);
  });
});
