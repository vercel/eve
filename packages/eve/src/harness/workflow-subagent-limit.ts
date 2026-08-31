import type { RuntimeActionRequest } from "#shared/action-types.js";

/**
 * Default maximum number of subagent (and remote-agent) calls one `Workflow`
 * tool invocation may dispatch.
 */
export const DEFAULT_WORKFLOW_MAX_SUBAGENTS = 100;

/**
 * Partition of one workflow interrupt's pending runtime actions against the
 * invocation's subagent budget. `allowed` actions may dispatch; `blocked`
 * actions must resolve with an error result instead of starting a child.
 */
export type WorkflowSubagentDispatchPlan = {
  readonly allowed: readonly RuntimeActionRequest[];
  readonly blocked: readonly RuntimeActionRequest[];
  readonly maxSubagents: number;
  readonly usedCalls: number;
};

/**
 * Splits the pending actions of one workflow interrupt into the prefix that
 * still fits the invocation's `maxSubagents` budget and the remainder that
 * must be blocked. Actions keep ledger order so results pair with the
 * sandbox program's call order.
 */
export function planWorkflowSubagentDispatch(input: {
  readonly actions: readonly RuntimeActionRequest[];
  readonly maxSubagents?: number;
  readonly usedCalls: number;
}): WorkflowSubagentDispatchPlan {
  const maxSubagents = input.maxSubagents ?? DEFAULT_WORKFLOW_MAX_SUBAGENTS;
  const usedCalls = input.usedCalls;
  const remaining = Math.max(0, maxSubagents - usedCalls);

  return {
    allowed: input.actions.slice(0, remaining),
    blocked: input.actions.slice(remaining),
    maxSubagents,
    usedCalls,
  };
}
