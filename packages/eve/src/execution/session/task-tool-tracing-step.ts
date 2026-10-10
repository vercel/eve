import {
  publishFromSessionStep,
  restoreSessionStep,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import { withSessionStateDelta } from "#execution/session/state-delta.js";
import {
  bindSessionInstrumentation,
  type ExecutionInstrumentation,
} from "#instrumentation/runtime.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

/** The step output preserves the start time when the workflow resumes in another worker. */
export async function startTaskToolCallsStep(): Promise<number> {
  "use step";
  return Date.now();
}

export async function traceTaskToolCallStep(
  target: SessionStepState,
  call: Parameters<ExecutionInstrumentation["instrumentTaskToolCall"]>[0],
) {
  "use step";
  return await withSessionStateDelta(target, async (input) => {
    const restored = await restoreSessionStep(input);
    const { published } = await publishFromSessionStep(restored, {
      origin: "own",
      async publish(_emit, session) {
        const instrumentation = bindSessionInstrumentation({
          ctx: restored.ctx,
          agentName: resolveEffectiveAgentRuntime(restored.ctx.require(BundleKey), restored.ctx)
            .turnAgent.id,
          rootSessionId: session.rootSessionId ?? session.sessionId,
          sessionId: session.sessionId,
        });
        await instrumentation?.instrumentTaskToolCall(call);
      },
    });
    return published;
  });
}
