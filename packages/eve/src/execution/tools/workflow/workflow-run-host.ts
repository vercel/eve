import {
  createHook,
  getWorkflowMetadata,
  sleep,
  type Hook,
} from "#compiled/@workflow/core/index.js";
import {
  cancelAgentSessionTurnStep,
  createRemoteReplyTokenStep,
  endAgentSessionsStep,
  openAgentSessionStep,
  sendAgentSessionMessageStep,
  stopLateAgentSessionStep,
} from "#execution/agent-sessions/steps.js";
import { disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import type { RunHook, RunHost } from "#execution/run-host.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { workflowToolStubs } from "#execution/workflow-host/tool-stubs.js";

export const workflowRunHost: RunHost = {
  runId: () => getWorkflowMetadata().workflowRunId,
  createHook: <T>(token?: string) =>
    runHookOf(createHook<T>(token === undefined ? undefined : { token })),
  createRemoteReplyHook: async <T>() =>
    runHookOf(createHook<T>({ token: await createRemoteReplyTokenStep() })),
  sleep: (ms) => sleep(ms),
  resumeHook: (token, payload, options) => resumeHookStep(token, payload, options),
  agentSessions: {
    cancelTurn: cancelAgentSessionTurnStep,
    end: endAgentSessionsStep,
    open: openAgentSessionStep,
    send: sendAgentSessionMessageStep,
    stopLate: stopLateAgentSessionStep,
  },
  toolStubs: workflowToolStubs,
};

function runHookOf<T>(hook: Hook<T>): RunHook<T> {
  return {
    token: hook.token,
    [Symbol.asyncIterator]: () => hook[Symbol.asyncIterator](),
    dispose: () => disposeHook(hook),
    claim: () =>
      hook.getConflict().then(
        (conflict) => conflict === null,
        (error: unknown) => {
          if (isHookConflictError(error)) return false;
          throw error;
        },
      ),
  };
}
