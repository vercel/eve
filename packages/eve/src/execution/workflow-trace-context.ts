import type { ContextContainer } from "#context/container.js";
import { ParentSessionKey, ParentTraceContextKey } from "#context/keys.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import type { HarnessInstrumentation } from "#harness/instrumentation/runtime.js";
import { resolveParentLineage } from "#harness/parent-lineage.js";
import { prepareTurnTraceContext } from "#harness/prepare-trace-context.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeIdentity, RuntimeTraceContext } from "#protocol/message.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

/** Prepares native tracing for workflow-owned preambles emitted outside the tool loop. */
export async function prepareWorkflowPreambleTrace(input: {
  readonly ctx: ContextContainer;
  readonly emissionState: HarnessEmissionState;
  readonly instrumentation?: HarnessInstrumentation;
  readonly runtimeIdentity: RuntimeIdentity;
  readonly session: HarnessSession;
}): Promise<RuntimeTraceContext | undefined> {
  const parent = input.ctx.get(ParentSessionKey);
  return await prepareTurnTraceContext({
    agentName: input.runtimeIdentity.agentName,
    instrumentation: input.instrumentation,
    parentLineage: resolveParentLineage(parent, input.ctx.get(ChannelKey)),
    parentTraceContext: input.ctx.get(ParentTraceContextKey),
    rootSessionId: parent?.rootSessionId ?? input.session.rootSessionId ?? input.session.sessionId,
    sequence: input.emissionState.sequence,
    sessionId: input.session.sessionId,
    sessionStarted: input.emissionState.sessionStarted,
    turnId: `turn_${input.emissionState.sequence}`,
  });
}
