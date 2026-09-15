import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";

/**
 * Default maximum number of subagent (and remote-agent) calls one `Workflow`
 * tool invocation may dispatch.
 */
export const DEFAULT_WORKFLOW_MAX_SUBAGENTS = 100;

/**
 * Partition of one workflow interrupt's pending tasks against the invocation's
 * subagent budget. Allowed tasks may dispatch; blocked tasks resolve with an
 * error result instead of starting a child.
 */
export type WorkflowSubagentDispatchPlan = {
  readonly allowed: readonly RuntimeWorkflowTaskRequest[];
  readonly blocked: readonly RuntimeWorkflowTaskRequest[];
  readonly maxSubagents: number;
  readonly usedCalls: number;
};

/**
 * Splits the pending actions of one workflow interrupt into the prefix that
 * still fits the invocation's `maxSubagents` budget and the remainder that
 * must be blocked. Actions keep request order so results pair with the sandbox
 * program's call order.
 */
export function planWorkflowSubagentDispatch(input: {
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  readonly maxSubagents?: number;
  readonly usedCalls: number;
}): WorkflowSubagentDispatchPlan {
  const maxSubagents = input.maxSubagents ?? DEFAULT_WORKFLOW_MAX_SUBAGENTS;
  const usedCalls = input.usedCalls;
  let remaining = Math.max(0, maxSubagents - usedCalls);
  const allowed: RuntimeWorkflowTaskRequest[] = [];
  const blocked: RuntimeWorkflowTaskRequest[] = [];
  for (const task of input.tasks) {
    if (task.resultKind !== "subagent") {
      allowed.push(task);
    } else if (remaining > 0) {
      allowed.push(task);
      remaining--;
    } else {
      blocked.push(task);
    }
  }

  return {
    allowed,
    blocked,
    maxSubagents,
    usedCalls,
  };
}
