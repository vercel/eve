import type { ToolStubHost } from "#execution/tool-stub-host.js";
import { withStubPlayback } from "#execution/tool-stubs/playback.js";
import { callToolStubStep, reportStubFailureStep } from "#execution/tool-stubs/steps.js";

export const workflowToolStubs: ToolStubHost = {
  serve: (scope, sessionId, run) => withStubPlayback(scope, sessionId, run),
  call: (scope, call) => callToolStubStep(scope, call),
  fail: (scope, callId, error) => reportStubFailureStep(scope, callId, error),
};
