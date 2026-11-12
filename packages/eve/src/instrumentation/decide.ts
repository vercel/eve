import {
  DEFAULT_DECISION_MODEL,
  decideWithMetadata,
  resolveDecisionModel,
} from "#ai/decision-adapter.js";
import type { DecisionOptions, DecisionQuestion } from "#ai/decision-types.js";
import { Experimental_DecisionRefusalError as DecisionRefusalError } from "#compiled/@ai-sdk/provider/index.js";
import { context } from "#compiled/@opentelemetry/api/index.js";
import { currentCapture } from "#compiled/@vercel/agent-runs/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey, SessionKey } from "#context/keys.js";
import {
  aiSdkCapture,
  getRegisteredTelemetryIntegrations,
} from "#instrumentation/ai-sdk-telemetry.js";
import { shouldCaptureInstrumentationContent } from "#shared/instrumentation-content.js";
import { getInstrumentationRuntime } from "#instrumentation/runtime-global.js";
import { readInstrumentationSessionContext } from "#instrumentation/session-context.js";
import { resolveInstrumentationTraceDecision } from "#instrumentation/trace-decision.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { applyLiveDeliveryAudienceCeiling } from "#shared/forwarded-trace-policy.js";
import { readSessionTraceDecision } from "#tracing/eve/agent-trace-context-store.js";
import { withChannelAudience } from "#tracing/eve/channel-audience-context.js";
import { withOperationTraceContext } from "#tracing/eve/conversation-context.js";
import { gatewayCostAttributes, readGatewayCostData } from "#tracing/eve/gateway.js";
import { eveTurnIdentity } from "#tracing/eve/operation-input.js";
import { resolveTraceRootSessionId } from "#shared/trace-root.js";

/** Decision calls can run before a model attempt or outside an eve session. */
export async function decideWithTracing<
  const Questions extends Readonly<Record<string, DecisionQuestion>>,
>(options: DecisionOptions<Questions>) {
  const runtime = getInstrumentationRuntime();
  if (runtime === undefined) return decideWithMetadata(options);
  const ctx = contextStorage.getStore() ?? new ContextContainer();
  const session = readInstrumentationSessionContext(ctx);
  const agentName = ctx.get(BundleKey)?.resolvedAgent.config?.name ?? "eve";
  const hooks = runtime.hooks.forTrace?.({ agentName, ...session.conversation }) ?? runtime.hooks;
  const settings = runtime.otelSettings;
  const traceDecision = runtime.decision;
  if (settings === undefined || traceDecision === undefined) {
    const content = shouldCaptureInstrumentationContent(session.conversation);
    return decideWithMetadata(options, {
      telemetry: aiSdkCapture({ recordInputs: content, recordOutputs: content }, hooks),
    });
  }
  const sessionId = ctx.get(SessionIdKey);
  const turnId = ctx.get(SessionKey)?.turn.id;
  const turnContext =
    sessionId === undefined || turnId === undefined
      ? undefined
      : await runtime.readTurnTraceContext?.(sessionId, turnId);
  const decision = resolveInstrumentationTraceDecision(
    settings,
    agentName,
    session.conversation,
    session.traceSeed,
    sessionId === undefined ? undefined : readSessionTraceDecision(ctx, sessionId),
  );
  const effective =
    decision === undefined
      ? undefined
      : applyLiveDeliveryAudienceCeiling(
          decision,
          session.audience,
          session.forwardedTracePolicy,
          session.conversation.environment,
        );
  const inherited = currentCapture();
  const record = effective?.action === "record";
  const capture = {
    emit: record && inherited?.emit !== false,
    recordInputs: record && effective.recordInputs && inherited?.recordInputs !== false,
    recordOutputs: record && effective.recordOutputs && inherited?.recordOutputs !== false,
  };
  let host = withChannelAudience(context.active(), session.audience);
  if (sessionId !== undefined)
    host = withOperationTraceContext(host, {
      sessionId,
      rootSessionId: session.parent?.rootSessionId,
      traceSessionId: resolveTraceRootSessionId(ctx, sessionId),
    });
  const model = resolveDecisionModel(options.model ?? DEFAULT_DECISION_MODEL);
  const operation = await traceDecision({
    modelId: typeof model === "string" ? model : model.modelId,
    provider: typeof model === "string" ? undefined : model.provider,
    identity:
      sessionId === undefined || turnId === undefined
        ? undefined
        : eveTurnIdentity({ sessionId, rootSessionId: session.parent?.rootSessionId, turnId }),
    agentName: settings.functionId ?? agentName,
    capture,
    parent: turnContext ?? session.traceSeed,
    context: host,
  });
  // eve owns this operation; the SDK integration would emit a second pair of spans.
  const telemetry = {
    integrations: [...getRegisteredTelemetryIntegrations({ excludeEveOtelIntegration: true })],
    ...aiSdkCapture(operation.capture, hooks),
  };
  try {
    const result = await operation.run(() =>
      decideWithMetadata({ ...options, model }, { telemetry }),
    );
    operation.attributes({
      "gen_ai.response.id": result.response.id,
      "gen_ai.response.model": result.response.modelId,
      ...gatewayCostAttributes(readGatewayCostData(result.providerMetadata) ?? {}),
    });
    await operation.complete({
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    });
    return result;
  } catch (error) {
    // A refusal is an answer, not a failed request. SDK errors can retain inputs and outputs on
    // enumerable properties, so a failure records only its type.
    await operation.complete(
      DecisionRefusalError.isInstance(error)
        ? { outcome: "refused" }
        : { failed: true, errorCode: "decision_error" },
    );
    throw error;
  }
}
