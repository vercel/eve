import { contextScopeValue, withContextScopeValue } from "#context/container.js";

// Branch-local rather than a context key: a step called without its tool
// context runs in the delivery's context in development and in none in
// production, and neither may change. `Symbol.for` because a step bundle can
// inline eve while authored code imports it from disk, over one shared ALS.
const WORKFLOW_STEP = Symbol.for("eve.workflowStep");

/** Runs a workflow tool's `"use step"` function, whose context never carries session state. */
export function runInWorkflowStep<T>(fn: () => T): T {
  return withContextScopeValue(WORKFLOW_STEP, true, fn);
}

export function isInWorkflowStep(): boolean {
  return contextScopeValue(WORKFLOW_STEP) === true;
}
