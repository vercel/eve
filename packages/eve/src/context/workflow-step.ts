import { contextScopeValue, withContextScopeValue } from "#context/container.js";

const WORKFLOW_STEP = Symbol.for("eve.workflowStep");

export function runInWorkflowStep<T>(fn: () => T): T {
  return withContextScopeValue(WORKFLOW_STEP, true, fn);
}

export function isInWorkflowStep(): boolean {
  return contextScopeValue(WORKFLOW_STEP) === true;
}
