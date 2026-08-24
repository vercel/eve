import type { ContextContainer } from "#context/container.js";
import { ChannelInstrumentationKey, InstrumentationDecisionKey } from "#context/keys.js";
import {
  getInstrumentationRuntime,
  type ConstructedInstrumentation,
  type InstrumentationRuntime,
} from "#harness/instrumentation/runtime.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";

const UNINSTRUMENTED: ConstructedInstrumentation = { run: (execute) => execute() };

/** Resolves audience once, then constructs the only instrumentation visible to the harness. */
export function prepareDeliveryInstrumentation(input: {
  readonly agentName?: string;
  readonly ctx: ContextContainer;
  readonly delivery?: { readonly kind: string };
  readonly instrumentation?: InstrumentationRuntime;
  readonly rootSessionId: string;
  readonly sessionId: string;
}): ConstructedInstrumentation {
  const instrumentation = input.instrumentation;
  if (instrumentation === undefined) return UNINSTRUMENTED;

  let decision = input.ctx.get(InstrumentationDecisionKey);
  if (decision === undefined || input.delivery?.kind === "deliver") {
    decision = instrumentation.resolveDecision({
      agentName: input.agentName,
      audience: normalizeChannelAudience(
        input.ctx.get(ChannelInstrumentationKey)?.metadata.audience,
      ),
      rootSessionId: input.rootSessionId,
      sessionId: input.sessionId,
    });
    input.ctx.set(InstrumentationDecisionKey, decision);
  }
  return instrumentation.construct(decision);
}

export function reconstructInstrumentation(
  serializedContext: Record<string, unknown>,
): ConstructedInstrumentation {
  const instrumentation = getInstrumentationRuntime();
  const decision = serializedContext[InstrumentationDecisionKey.name];
  return instrumentation !== undefined && typeof decision === "object" && decision !== null
    ? instrumentation.construct(decision as Parameters<InstrumentationRuntime["construct"]>[0])
    : UNINSTRUMENTED;
}
