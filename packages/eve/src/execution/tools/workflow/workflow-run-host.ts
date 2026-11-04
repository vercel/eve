import {
  createHook,
  getWorkflowMetadata,
  sleep,
  type Hook,
} from "#compiled/@workflow/core/index.js";
import {
  cancelAgentSessionTurnStep,
  endAgentSessionsStep,
  openAgentSessionStep,
  sendAgentSessionMessageStep,
  stopLateAgentSessionStep,
} from "#execution/agent-sessions/steps.js";
import { disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import type { RunHook, RunHost } from "#execution/run-host.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";

// A workflow tool run on Workflow: the run is a durable workflow, its hooks are Workflow hooks on
// that run, its sleeps are durable, and it opens agent sessions in steps.

export const workflowRunHost: RunHost = {
  runId: () => getWorkflowMetadata().workflowRunId,
  createHook: <T>(token?: string) =>
    runHookOf(createHook<T>(token === undefined ? undefined : { token })),
  sleep: (ms) => sleep(ms),
  resumeHook: (token, payload, options) => resumeHookStep(token, payload, options),
  agentSessions: {
    cancelTurn: cancelAgentSessionTurnStep,
    end: endAgentSessionsStep,
    open: openAgentSessionStep,
    send: sendAgentSessionMessageStep,
    stopLate: stopLateAgentSessionStep,
  },
};

/** A Workflow hook as a run's hook: it claims its token by asking Workflow for a conflict. */
function runHookOf<T>(hook: Hook<T>): RunHook<T> {
  return {
    token: hook.token,
    [Symbol.asyncIterator]: () => hook[Symbol.asyncIterator](),
    dispose: () => disposeHook(hook),
    claim: () =>
      hook.getConflict().then(
        (conflict) => conflict === null,
        // A World that can't name the holder rejects instead.
        (error: unknown) => {
          if (isHookConflictError(error)) return false;
          throw error;
        },
      ),
  };
}
