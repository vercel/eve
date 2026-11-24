import { context } from "#compiled/@opentelemetry/api/index.js";
import { currentCapture, type DecisionOperation } from "#compiled/@vercel/agent-runs/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey, SessionKey } from "#context/keys.js";
import { getInstrumentationRuntime } from "#instrumentation/runtime-global.js";
import { readInstrumentationSessionContext } from "#instrumentation/session-context.js";
import { resolveInstrumentationTraceDecision } from "#instrumentation/trace-decision.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  applyLiveDeliveryAudienceCeiling,
  defaultContentCapture,
} from "#shared/forwarded-trace-policy.js";
import { resolveTraceRootSessionId } from "#shared/trace-root.js";
import { readSessionTraceDecision } from "#tracing/eve/agent-trace-context-store.js";
import { withChannelAudience } from "#tracing/eve/channel-audience-context.js";
import { withOperationTraceContext } from "#tracing/eve/conversation-context.js";
import { gatewayCostAttributes, readGatewayCostData } from "#tracing/eve/gateway.js";
import { eveTurnIdentity } from "#tracing/eve/operation-input.js";

type ModelCallType = "decision" | "extraction";
type TracedModel = string | { readonly modelId: string; readonly provider: string };
type Hooks = NonNullable<ReturnType<typeof getInstrumentationRuntime>>["hooks"];

export type ModelCallTrace<Model extends TracedModel> =
  | {
      readonly hooks: Hooks;
      readonly content: ReturnType<typeof defaultContentCapture>;
      readonly operation?: undefined;
    }
  | { readonly hooks: Hooks; readonly operation: DecisionOperation; readonly model: Model };

export async function startModelCallTrace<Model extends TracedModel>(
  type: ModelCallType,
  resolveModel: () => Model,
  purpose?: string,
): Promise<ModelCallTrace<Model> | undefined> {
  const runtime = getInstrumentationRuntime();
  if (runtime === undefined) return undefined;
  const ctx = contextStorage.getStore() ?? new ContextContainer();
  const session = readInstrumentationSessionContext(ctx);
  const agentName = ctx.get(SessionAgentKey)?.name ?? "eve";
  const ceiling = session.forwardedTracePolicy?.ceiling;
  const hooks =
    runtime.hooks.forTrace?.({ agentName, ...session.conversation }, { ceiling }) ?? runtime.hooks;
  const settings = runtime.otelSettings;
  const start = type === "decision" ? runtime.decision : runtime.extraction;
  if (settings === undefined || start === undefined) {
    return { hooks, content: defaultContentCapture(session.conversation, ceiling) };
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
  const model = resolveModel();
  const input = {
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
  };
  const operation = await (type === "decision" ? start({ ...input, purpose }) : start(input));
  return { hooks, operation, model };
}

export async function runTracedModelCall<
  Result extends {
    readonly usage: { readonly inputTokens?: number; readonly outputTokens?: number };
    readonly response: { readonly id?: string; readonly modelId: string };
    readonly providerMetadata?: Parameters<typeof readGatewayCostData>[0];
  },
>(
  type: ModelCallType,
  operation: DecisionOperation,
  execute: () => Promise<Result>,
  results: {
    readonly completed: (result: Result) => unknown;
    readonly refused: (error: unknown) => unknown;
  },
): Promise<Result> {
  try {
    const result = await operation.run(execute);
    operation.attributes({
      "gen_ai.response.id": result.response.id,
      "gen_ai.response.model": result.response.modelId,
      ...gatewayCostAttributes(readGatewayCostData(result.providerMetadata) ?? {}),
    });
    await operation.complete({
      output: results.completed(result),
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    });
    return result;
  } catch (error) {
    const refused = results.refused(error);
    await operation.complete(
      refused === undefined ? { failed: true, errorCode: `${type}_error` } : { output: refused },
    );
    throw error;
  }
}
