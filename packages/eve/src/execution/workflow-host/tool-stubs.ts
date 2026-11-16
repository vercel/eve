import type { ToolStubHost } from "#execution/tool-stub-host.js";
import { withStubPlayback } from "#execution/tool-stubs/playback.js";
import { callToolStubStep, reportStubFailureStep } from "#execution/tool-stubs/steps.js";

/**
 * Workflow's tool stubs: the root session's run serves them on a hook (`tool-stubs/playback.ts`),
 * and calls reach it in steps. Each member calls its step unbound, since a step called as a
 * method serializes its receiver.
 */
export const workflowToolStubs: ToolStubHost = {
  serve: (scope, sessionId, run) => withStubPlayback(scope, sessionId, run),
  call: (scope, call) => callToolStubStep(scope, call),
  fail: (scope, callId, error) => reportStubFailureStep(scope, callId, error),
};
