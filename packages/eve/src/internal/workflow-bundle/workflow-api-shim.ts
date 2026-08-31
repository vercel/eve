/**
 * Stand-in for `workflow/api` inside the workflow driver. The runtime API
 * drives runs from outside a body and imports Node.js internals that must not
 * enter the replayed code, so an authored body that reaches it gets the rule
 * instead of the runtime. Every value the SDK exports is present so the import
 * binds; each one fails when called.
 */
function unavailable(name: string): never {
  throw new Error(
    `\`${name}\` from "workflow/api" is not available inside a workflow body. ` +
      `Call it from a "use step" function and await that step from the body.`,
  );
}

export const cancelRun = (): never => unavailable("cancelRun");
export const cancelRuns = (): never => unavailable("cancelRuns");
export const createWorld = (): never => unavailable("createWorld");
export const createWorldFromModule = (): never => unavailable("createWorldFromModule");
export const getHookByToken = (): never => unavailable("getHookByToken");
export const getRun = (): never => unavailable("getRun");
export const getWorld = (): never => unavailable("getWorld");
export const getWorldHandlers = (): never => unavailable("getWorldHandlers");
export const healthCheck = (): never => unavailable("healthCheck");
export const listStreams = (): never => unavailable("listStreams");
export const readStream = (): never => unavailable("readStream");
export const recreateRunFromExisting = (): never => unavailable("recreateRunFromExisting");
export const reenqueueRun = (): never => unavailable("reenqueueRun");
export const resumeHook = (): never => unavailable("resumeHook");
export const resumeWebhook = (): never => unavailable("resumeWebhook");
export const setWorld = (): never => unavailable("setWorld");
export const start = (): never => unavailable("start");
export const wakeUpRun = (): never => unavailable("wakeUpRun");
export const workflowEntrypoint = (): never => unavailable("workflowEntrypoint");

export class Run {
  constructor() {
    unavailable("Run");
  }
}

export class WorkflowSuspension {
  constructor() {
    unavailable("WorkflowSuspension");
  }
}
