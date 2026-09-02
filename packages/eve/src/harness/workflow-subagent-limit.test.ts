import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKFLOW_MAX_SUBAGENTS,
  planWorkflowSubagentDispatch,
} from "#harness/workflow-subagent-limit.js";
import type { PendingDispatchAction } from "#shared/dispatch-action.js";

function createAction(index: number): PendingDispatchAction {
  return {
    callId: `call-${index}`,
    description: "",
    input: {},
    target: {
      kind: "subagent-call",
      nodeId: "subagents/echo-marker",
      subagentName: "echo-marker",
    },
    toolName: "echo-marker",
  };
}

describe("planWorkflowSubagentDispatch", () => {
  it("allows every pending action while the budget holds", () => {
    const actions = [createAction(1), createAction(2)];
    const plan = planWorkflowSubagentDispatch({
      actions,
      maxSubagents: 3,
      usedCalls: 0,
    });

    expect(plan.allowed).toEqual(actions);
    expect(plan.blocked).toEqual([]);
    expect(plan.usedCalls).toBe(0);
  });

  it("blocks actions beyond the remaining budget while preserving order", () => {
    const actions = [createAction(1), createAction(2), createAction(3)];
    const plan = planWorkflowSubagentDispatch({
      actions,
      maxSubagents: 3,
      usedCalls: 1,
    });

    expect(plan.allowed).toEqual([actions[0], actions[1]]);
    expect(plan.blocked).toEqual([actions[2]]);
    expect(plan.usedCalls).toBe(1);
  });

  it("blocks everything once the persisted budget is spent", () => {
    const plan = planWorkflowSubagentDispatch({
      actions: [createAction(1)],
      maxSubagents: 2,
      usedCalls: 2,
    });

    expect(plan.allowed).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
  });

  it("defaults the budget to DEFAULT_WORKFLOW_MAX_SUBAGENTS", () => {
    const plan = planWorkflowSubagentDispatch({
      actions: [createAction(1)],
      usedCalls: 0,
    });

    expect(plan.maxSubagents).toBe(DEFAULT_WORKFLOW_MAX_SUBAGENTS);
  });
});
