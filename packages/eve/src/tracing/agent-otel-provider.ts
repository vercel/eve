import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  type Context,
  type Span,
  type SpanContext,
  type Tracer,
  trace,
} from "#compiled/@opentelemetry/api/index.js";

import { contextStorage } from "#context/container.js";
import { SessionTraceSeedKey } from "#context/keys.js";
import { withoutInstrumentationContent } from "#instrumentation/content.js";
import { instrumentationEventForTraceDecision } from "#instrumentation/content-policy.js";
import type { AgentTraceStateStore, AgentTurnTraceState } from "#tracing/agent-trace-state.js";
import {
  contentAttribute,
  genAiInputMessagesAttribute,
  genAiOutputMessagesAttribute,
  genAiSystemInstructionsAttribute,
  messagesContentAttribute,
  systemPromptAttribute,
  textContentAttribute,
  toolResultsContentAttribute,
} from "#tracing/agent-otel-content.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { createAgentActionInstrumentation } from "#tracing/agent-action-instrumentation.js";
import { createAgentApprovalInstrumentation } from "#tracing/agent-approval-instrumentation.js";
import { createAgentChannelDeliveryInstrumentation } from "#tracing/agent-channel-delivery-instrumentation.js";
import { createAgentToolInstrumentation } from "#tracing/agent-tool-instrumentation.js";
import { markAgentTraceContext } from "#tracing/agent-trace-context.js";
import { runtimeContextAttributes } from "#tracing/agent-otel-runtime-context.js";
import { setSpanUsage } from "#tracing/agent-otel-usage.js";
import { createAgentOtelSessionContext } from "#tracing/agent-otel-session-context.js";
import type { TraceCapturePolicy } from "#tracing/otel-declaration.js";
import { isSampledTrace, resolveTracePolicyDecision } from "#tracing/sampled-trace.js";
import { withChannelAudience } from "#tracing/channel-audience-context.js";
import { suppressTracing } from "#tracing/suppress-tracing.js";
import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";
import type {
  InstrumentationEvent,
  InstrumentationStepAttemptMetadataEvent,
  InstrumentationAttemptScope,
  InstrumentationStepAttemptStartedEvent,
  InstrumentationStepAttemptTerminalEvent,
  InstrumentationContextRunner,
  InstrumentationModelCallTerminalEvent,
  InstrumentationModelCallStartedEvent,
  InstrumentationProviderDefinition,
  InstrumentationSessionStartedEvent,
  InstrumentationTraceSeed,
  InstrumentationSessionTransitionEvent,
  InstrumentationTurnStartedEvent,
  InstrumentationTurnTerminalEvent,
} from "#instrumentation/lifecycle.js";
import { attemptIdempotencyKey } from "#instrumentation/lifecycle.js";

interface SpanState {
  readonly context: Context;
  readonly span: Span;
}

export interface AgentOtelInstrumentationInput {
  /**
   * Whether to write model prompts and tool call inputs onto spans at all.
   * This is the union across destinations, not one destination's policy: a
   * destination that declined drops these on its way out instead.
   */
  readonly recordInputs?: boolean;
  /** The same, for model responses and tool call outputs. */
  readonly recordOutputs?: boolean;
  readonly frameworkVersion: string;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly stateStore: AgentTraceStateStore;
  readonly tracer: Tracer;
  readonly tracePolicy?: TraceCapturePolicy;
}

/** OTel event definition and its trusted framework context runner. */
export interface AgentOtelInstrumentation {
  readonly hook: InstrumentationProviderDefinition;
  readonly prepareSessionTrace: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
  readonly prepareTurnTrace: (
    event: InstrumentationTurnStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
  readonly runInContext: InstrumentationContextRunner;
}

/** Creates OTel instrumentation for eve's structural and GenAI spans. */
export function createAgentOtelInstrumentation(
  input: AgentOtelInstrumentationInput,
): AgentOtelInstrumentation {
  const recordInputs = input.recordInputs ?? false;
  const recordOutputs = input.recordOutputs ?? false;
  const executionContexts = new WeakMap<InstrumentationAttemptScope, Map<string, Context>>();
  const attemptScopes = new Map<string, InstrumentationAttemptScope>();
  // A serverless turn runs inside one `turnStep` "use step" invocation. If
  // that worker is lost, Workflow retries the whole step from entry rather
  // than resuming this callback sequence in a replacement process.
  const steps = new WeakMap<InstrumentationAttemptScope, SpanState>();
  const modelSpans = new WeakMap<InstrumentationAttemptScope, Map<string, SpanState>>();
  const actions = createAgentActionInstrumentation({
    frameworkVersion: input.frameworkVersion,
    idGenerator: input.idGenerator,
    recordInputs,
    recordOutputs,
    resolveTraceContext: async (event) => {
      const turn = await input.stateStore.getTurn(event.scope.sessionId, event.scope.turnId);
      return turn?.context;
    },
    stateStore: input.stateStore,
    tracer: input.tracer,
  });
  const approvals = createAgentApprovalInstrumentation({
    actionContextFor: actions.contextFor,
    frameworkVersion: input.frameworkVersion,
    idGenerator: input.idGenerator,
    tracer: input.tracer,
  });
  const tools = createAgentToolInstrumentation({
    actionContextFor: actions.contextFor,
    idGenerator: input.idGenerator,
    recordInputs,
    recordOutputs,
    resolveFallback: (event) => {
      const scope = attemptScopes.get(event.scope.attemptId) ?? event.scope;
      const step = steps.get(scope);
      return step === undefined
        ? undefined
        : { context: step.context, spanContext: step.span.spanContext() };
    },
    tracer: input.tracer,
  });
  const { ensureSessionContext, prepareSessionTrace, prepareTurnTrace } =
    createAgentOtelSessionContext(input);

  const projectEvent = async (event: InstrumentationEvent): Promise<InstrumentationEvent> => {
    const session = await input.stateStore.getSession(sessionIdForEvent(event));
    const audience = audienceForEvent(event, session?.channelAudience);
    const eventSeed = "traceSeed" in event ? event.traceSeed : undefined;
    const contextSeed = contextStorage.getStore()?.get(SessionTraceSeedKey);
    const decision =
      eventSeed?.decision ??
      contextSeed?.decision ??
      session?.decision ??
      (eventSeed !== undefined
        ? resolveTracePolicyDecision(isSampledTrace(eventSeed), audience)
        : contextSeed !== undefined
          ? resolveTracePolicyDecision(isSampledTrace(contextSeed), audience)
          : session !== undefined
            ? resolveTracePolicyDecision(isSampledTrace(session.context), audience)
            : undefined);
    if (decision === undefined) return withoutInstrumentationContent(event);
    return instrumentationEventForTraceDecision(
      event,
      decision.action === "drop"
        ? decision
        : {
            action: "record",
            recordInputs: recordInputs && decision.recordInputs,
            recordOutputs: recordOutputs && decision.recordOutputs,
          },
      audience,
    );
  };

  const onSessionStarted = async (event: InstrumentationSessionStartedEvent): Promise<void> => {
    await prepareSessionTrace(event);
  };

  const onTurnStarted = async (event: InstrumentationTurnStartedEvent): Promise<void> => {
    await prepareTurnTrace(event);
  };

  const onStepStarted = async (event: InstrumentationStepAttemptStartedEvent): Promise<void> => {
    const turn = await input.stateStore.getTurn(event.scope.sessionId, event.scope.turnId);
    if (turn === undefined || !isSampledTrace(turn.context)) return;
    const turnContext = withChannelAudience(
      contextFromSpanContext(turn.context),
      event.scope.channelAudience,
    );
    const activeSpanContext = trace.getSpan(context.active())?.spanContext();
    const stepSpan = input.idGenerator.withSpanId(
      input.idGenerator.deriveSpanId(attemptIdempotencyKey(event.scope)),
      () =>
        input.tracer.startSpan(
          "agent.step",
          {
            attributes: {
              "agent.session.id": event.scope.sessionId,
              "agent.framework.name": "eve",
              "agent.framework.version": input.frameworkVersion,
              "agent.step.attempt": event.scope.attemptIndex,
              "agent.step.index": event.scope.stepIndex,
              "agent.turn.id": event.scope.turnId,
              "agent.name": event.scope.functionId,
              ...runtimeContextAttributes(event.runtimeContext),
            },
            links:
              activeSpanContext === undefined || activeSpanContext.traceId === turn.context.traceId
                ? undefined
                : [
                    {
                      attributes: { "eve.link.type": "workflow.delivery" },
                      context: activeSpanContext,
                    },
                  ],
          },
          turnContext,
        ),
    );
    stepSpan.addEvent("step.started");
    const stepContext = trace.setSpan(turnContext, stepSpan);
    steps.set(event.scope, { context: stepContext, span: stepSpan });
    attemptScopes.set(event.scope.attemptId, event.scope);
  };

  const onStepTerminal = async (event: InstrumentationStepAttemptTerminalEvent): Promise<void> => {
    const scope = attemptScopes.get(event.scope.attemptId) ?? event.scope;
    executionContexts.delete(scope);
    drainOpenSpans({ ...event, scope });
    tools.drain(
      event.scope.attemptId,
      event.type === "step.attempt.failed" ? { error: event.error } : undefined,
    );
    if (event.type === "step.attempt.failed") {
      await actions.failForAttempt(scope, event.error);
    }
    attemptScopes.delete(event.scope.attemptId);
    const attempt = steps.get(scope);
    if (attempt === undefined) return;
    // The span event drops the `attempt` segment: this span *is* one attempt,
    // and `agent.step.attempt` on it already says which.
    attempt.span.addEvent(
      event.type === "step.attempt.completed" ? "step.completed" : "step.failed",
    );
    if (event.type === "step.attempt.failed") {
      recordError(attempt.span, event.error);
    }
    attempt.span.end();
    steps.delete(scope);
  };

  const onTurnTerminal = async (event: InstrumentationTurnTerminalEvent): Promise<void> => {
    if (event.type === "turn.cancelled" || event.type === "turn.failed") {
      await actions.deleteForTurn(event.sessionId, event.turnId);
    }
    await input.stateStore.updateTurn(event.sessionId, event.turnId, (turn) => ({
      ...turn,
      terminal:
        event.type === "turn.failed"
          ? { error: event.error, type: event.type }
          : { type: event.type },
    }));
  };

  const onSessionTransition = async (
    event: InstrumentationSessionTransitionEvent,
  ): Promise<void> => {
    if (event.turnId !== undefined) {
      const turn = await input.stateStore.getTurn(event.sessionId, event.turnId);
      if (turn !== undefined) {
        const session = await input.stateStore.getSession(event.sessionId);
        if (isSampledTrace(turn.context)) {
          const agentName = session?.agentName ?? turn.subagentName;
          const span = input.idGenerator.withSpanId(turn.context.spanId, () =>
            input.tracer.startSpan(
              agentSpanName(agentName),
              {
                attributes: {
                  "agent.framework.name": "eve",
                  "agent.framework.version": input.frameworkVersion,
                  "agent.name": agentName,
                  "agent.session.id": event.sessionId,
                  "agent.subagent.name": turn.subagentName,
                  "agent.turn.id": event.turnId,
                  "agent.turn.sequence": turn.sequence,
                  "gen_ai.agent.name": agentName,
                  "gen_ai.conversation.id": event.sessionId,
                  "gen_ai.operation.name": "invoke_agent",
                },
                kind: SpanKind.INTERNAL,
                startTime: turn.startTimeMs,
              },
              contextFromSpanContext({
                isRemote: turn.parentIsRemote ?? false,
                spanId: turn.parentSpanId,
                traceFlags: turn.context.traceFlags,
                traceId: turn.context.traceId,
              }),
            ),
          );
          setAgentInvocationUsage(span, turn.modelUsage);
          span.addEvent("turn.started", undefined, turn.startTimeMs);
          if (turn.terminal !== undefined) {
            span.addEvent(turn.terminal.type);
            if (turn.terminal.type === "turn.failed") {
              recordError(span, turn.terminal.error);
            }
          }
          span.end();
        }
        await input.stateStore.deleteTurn(event.sessionId, event.turnId);
      }
    }
    // `session.waiting` is not terminal — the session may resume with a new
    // turn that still needs its metadata — so only release session-scoped
    // state on terminal transitions.
    if (event.type === "session.completed" || event.type === "session.failed") {
      await actions.deleteForSession(event.sessionId);
      await input.stateStore.deleteSession(event.sessionId);
    }
  };

  const onModelCallStarted = (event: InstrumentationModelCallStartedEvent): void => {
    const attempt = steps.get(event.scope);
    if (attempt === undefined) return;
    attempt.span.setAttribute("agent.model.id", event.model.modelId);
    attempt.span.setAttribute("agent.model.provider", event.model.provider);
    const span = input.tracer.startSpan(
      modelSpanName(event.model.modelId),
      {
        attributes: {
          "gen_ai.agent.name": event.scope.functionId,
          "gen_ai.conversation.id": event.scope.sessionId,
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": event.model.provider,
          "gen_ai.request.model": event.model.modelId,
          ...runtimeContextAttributes(event.runtimeContext),
        },
        kind: SpanKind.CLIENT,
      },
      attempt.context,
    );
    if (recordInputs && event.input !== undefined) {
      const messages = messagesContentAttribute(event.input.messages);
      if (messages !== undefined) span.setAttribute("ai.prompt.messages", messages);
      const genAiMessages = genAiInputMessagesAttribute(event.input.messages);
      if (genAiMessages !== undefined) span.setAttribute("gen_ai.input.messages", genAiMessages);
      const system = systemPromptAttribute(event.input.instructions);
      if (system !== undefined) span.setAttribute("ai.prompt.system", system);
      const genAiSystem = genAiSystemInstructionsAttribute(event.input.instructions);
      if (genAiSystem !== undefined) {
        span.setAttribute("gen_ai.system_instructions", genAiSystem);
      }
    }
    const state = { context: trace.setSpan(attempt.context, span), span };
    getExecutionContexts(event.scope).set(event.idempotencyKey, state.context);
    getSpanStates(modelSpans, event.scope).set(event.idempotencyKey, state);
  };

  const onModelCallTerminal = async (
    event: InstrumentationModelCallTerminalEvent,
  ): Promise<void> => {
    executionContexts.get(event.scope)?.delete(event.idempotencyKey);
    const state = takeSpanState(modelSpans, event.scope, event.idempotencyKey);
    if (state === undefined) return;
    if (event.type === "model.call.failed") {
      recordError(state.span, event.error);
    } else {
      await recordTurnUsage(event);
      setSpanUsage(state.span, event.usage, "gen_ai");
      state.span.setAttribute("gen_ai.response.finish_reasons", [event.finishReason]);
      if (event.response?.id !== undefined) {
        state.span.setAttribute("gen_ai.response.id", event.response.id);
      }
      if (event.response?.modelId !== undefined) {
        state.span.setAttribute("gen_ai.response.model", event.response.modelId);
      }
      const attempt = steps.get(event.scope);
      if (attempt !== undefined) {
        setSpanUsage(attempt.span, event.usage, "agent");
      }
      if (recordOutputs) {
        state.span.setAttribute("ai.response.finish_reason", event.finishReason);
        const content = event.content;
        if (content === undefined) {
          state.span.end();
          return;
        }
        const outputMessages = genAiOutputMessagesAttribute(content, event.finishReason);
        if (outputMessages !== undefined) {
          state.span.setAttribute("gen_ai.output.messages", outputMessages);
        }
        const reasoning = textContentAttribute(
          content
            .filter((part) => part.type === "reasoning")
            .map((part) => part.text)
            .filter((part) => part.trim().length > 0)
            .join("\n"),
        );
        if (reasoning !== undefined) state.span.setAttribute("ai.response.reasoning", reasoning);
        const text = textContentAttribute(
          content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        );
        if (text !== undefined) state.span.setAttribute("ai.response.text", text);
        const toolCalls = content
          .filter((part) => part.type === "tool-call")
          .map((part) => ({ callId: part.callId, input: part.input, toolName: part.toolName }));
        if (toolCalls.length > 0) {
          const json = contentAttribute(toolCalls, false);
          if (json !== undefined) state.span.setAttribute("ai.response.tool_calls", json);
        }
        // Provider-executed tools (e.g. web_search) run inside the model call,
        // never reach eve's tool loop, and so never get an execute_tool span.
        // Their results only exist as content parts on the model response.
        const toolResults = content
          .filter((part) => part.type === "tool-result" || part.type === "tool-error")
          .map((part) =>
            part.type === "tool-result"
              ? {
                  callId: part.callId,
                  input: part.input,
                  output: part.output,
                  toolName: part.toolName,
                }
              : {
                  callId: part.callId,
                  error: errorText(part.error),
                  input: part.input,
                  toolName: part.toolName,
                },
          );
        if (toolResults.length > 0) {
          const json = toolResultsContentAttribute(toolResults);
          if (json !== undefined) state.span.setAttribute("ai.response.tool_results", json);
        }
      }
    }
    state.span.end();
  };

  const recordTurnUsage = async (
    event: Extract<
      InstrumentationModelCallTerminalEvent,
      { readonly type: "model.call.completed" }
    >,
  ): Promise<void> => {
    if (event.usage.inputTokens === undefined && event.usage.outputTokens === undefined) return;
    // The bridge publishes at most one completion per physical execution.
    // Workflow retries restart from pre-step state, so abandoned additions are
    // not merged; distinct completed retries consumed tokens and count here.
    await input.stateStore.updateTurn(event.scope.sessionId, event.scope.turnId, (turn) => ({
      ...turn,
      modelUsage: {
        inputTokens:
          event.usage.inputTokens === undefined
            ? turn.modelUsage?.inputTokens
            : (turn.modelUsage?.inputTokens ?? 0) + event.usage.inputTokens,
        outputTokens:
          event.usage.outputTokens === undefined
            ? turn.modelUsage?.outputTokens
            : (turn.modelUsage?.outputTokens ?? 0) + event.usage.outputTokens,
      },
    }));
  };

  const channelDeliveries = createAgentChannelDeliveryInstrumentation({
    ensureSessionContext,
    frameworkVersion: input.frameworkVersion,
    idGenerator: input.idGenerator,
    recordInputs,
    stateStore: input.stateStore,
    tracer: input.tracer,
  });

  const onStepMetadata = (event: InstrumentationStepAttemptMetadataEvent): void => {
    const attempt = steps.get(event.scope);
    if (attempt === undefined) return;
    // Vercel AI Gateway reports per-call cost in providerMetadata.gateway;
    // attributes exist only when it was actually the gateway serving the call.
    const costAttributes = readGatewayCost(event.providerMetadata);
    if (costAttributes === undefined) return;
    // The vendored OTel Span surface only has singular setAttribute.
    for (const [key, value] of Object.entries(costAttributes)) {
      attempt.span.setAttribute(key, value);
    }
  };

  return {
    hook: {
      events: {
        ...channelDeliveries,
        "action.completed": actions.events["action.completed"],
        "action.failed": actions.events["action.failed"],
        async "action.started"(event, ctx) {
          await actions.events["action.started"]!(event, ctx);
          await tools.actionStarted(event);
        },
        ...approvals,
        "step.attempt.completed": onStepTerminal,
        "step.attempt.failed": onStepTerminal,
        "step.attempt.metadata": onStepMetadata,
        "step.attempt.started": onStepStarted,
        "model.call.completed": onModelCallTerminal,
        "model.call.failed": onModelCallTerminal,
        "model.call.started": onModelCallStarted,
        "session.completed": onSessionTransition,
        "session.failed": onSessionTransition,
        "session.started": onSessionStarted,
        "session.waiting": onSessionTransition,
        ...tools.events,
        "turn.cancelled": onTurnTerminal,
        "turn.completed": onTurnTerminal,
        "turn.failed": onTurnTerminal,
        "turn.started": onTurnStarted,
      },
      name: "eve.otel",
      projectEvent,
      tracePolicy: () => ({ emit: true, recordInputs, recordOutputs }),
    },
    prepareSessionTrace,
    prepareTurnTrace,
    async runInContext(operation, execute) {
      const scope = attemptScopes.get(operation.scope.attemptId) ?? operation.scope;
      const contexts = executionContexts.get(scope);
      let parent =
        operation.type === "model.call"
          ? contexts?.get(operation.idempotencyKey)
          : tools.contextFor(operation.scope.attemptId, operation.idempotencyKey);
      if (parent === undefined) {
        const turn = await input.stateStore.getTurn(
          operation.scope.sessionId,
          operation.scope.turnId,
        );
        if (turn !== undefined) {
          parent = withChannelAudience(
            contextFromSpanContext(turn.context),
            operation.scope.channelAudience,
          );
          if (!isSampledTrace(turn.context)) parent = suppressTracing(parent);
        }
      }
      return parent === undefined
        ? execute()
        : context.with(markAgentTraceContext(parent), execute);
    },
  };

  function getExecutionContexts(scope: InstrumentationAttemptScope): Map<string, Context> {
    let state = executionContexts.get(scope);
    if (state === undefined) {
      state = new Map();
      executionContexts.set(scope, state);
    }
    return state;
  }

  function drainOpenSpans(event: InstrumentationStepAttemptTerminalEvent): void {
    for (const state of modelSpans.get(event.scope)?.values() ?? []) {
      if (event.type === "step.attempt.failed") recordError(state.span, event.error);
      state.span.end();
    }
    modelSpans.delete(event.scope);
  }
}

function sessionIdForEvent(event: InstrumentationEvent): string {
  return "scope" in event ? event.scope.sessionId : event.sessionId;
}

function audienceForEvent(
  event: InstrumentationEvent,
  sessionAudience: ChannelAudience | undefined,
): ChannelAudience {
  if ("delivery" in event) return normalizeChannelAudience(event.delivery.channelAudience);
  if ("scope" in event && event.scope.channelAudience !== undefined) {
    return normalizeChannelAudience(event.scope.channelAudience);
  }
  if (event.type === "session.started") {
    return normalizeChannelAudience(event.channelAudience);
  }
  return normalizeChannelAudience(sessionAudience);
}

function getSpanStates<T>(
  spans: WeakMap<InstrumentationAttemptScope, Map<string, T>>,
  scope: InstrumentationAttemptScope,
): Map<string, T> {
  let scoped = spans.get(scope);
  if (scoped === undefined) {
    scoped = new Map();
    spans.set(scope, scoped);
  }
  return scoped;
}

function takeSpanState<T>(
  spans: WeakMap<InstrumentationAttemptScope, Map<string, T>>,
  scope: InstrumentationAttemptScope,
  id: string,
): T | undefined {
  const scoped = spans.get(scope);
  const state = scoped?.get(id);
  if (scoped === undefined) return undefined;
  scoped.delete(id);
  if (scoped.size === 0) spans.delete(scope);
  return state;
}

function contextFromSpanContext(spanContext: SpanContext): Context {
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext));
}

/**
 * Extracts cost data from a step result's provider metadata. Only Vercel AI
 * Gateway reports it (`providerMetadata.gateway`): raw inference cost, the
 * gateway's surcharged total, the input/output split, and the generation id
 * for dashboard reconciliation. Values arrive as USD strings; anything
 * missing or non-numeric is skipped, so non-gateway providers get nothing.
 */
function readGatewayCost(
  providerMetadata: Readonly<Record<string, unknown>>,
): Record<string, string | number> | undefined {
  const gateway = providerMetadata.gateway;
  if (!isRecord(gateway)) return undefined;
  const attributes: Record<string, string | number> = {};
  const cost = readUsd(gateway.cost);
  if (cost !== undefined) attributes["gen_ai.usage.cost"] = cost;
  const gatewayCost = readUsd(gateway.gatewayCost);
  if (gatewayCost !== undefined) attributes["gen_ai.usage.gateway_cost"] = gatewayCost;
  const inputCost = readUsd(gateway.inputInferenceCost);
  if (inputCost !== undefined) attributes["gen_ai.usage.input_cost"] = inputCost;
  const outputCost = readUsd(gateway.outputInferenceCost);
  if (outputCost !== undefined) attributes["gen_ai.usage.output_cost"] = outputCost;
  if (typeof gateway.generationId === "string" && gateway.generationId.length > 0) {
    attributes["gen_ai.generation.id"] = gateway.generationId;
  }
  return Object.keys(attributes).length === 0 ? undefined : attributes;
}

function readUsd(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelSpanName(modelId: string): string {
  return `chat ${modelId}`;
}

function agentSpanName(agentName: string | undefined): string {
  return agentName === undefined ? "invoke_agent" : `invoke_agent ${agentName}`;
}

function setAgentInvocationUsage(span: Span, modelUsage: AgentTurnTraceState["modelUsage"]): void {
  if (modelUsage === undefined) return;
  if (modelUsage.inputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.input_tokens", modelUsage.inputTokens);
  }
  if (modelUsage.outputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.output_tokens", modelUsage.outputTokens);
  }
}

function errorText(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}

function recordError(span: Span, error: unknown): void {
  span.setAttribute("error.type", error instanceof Error ? error.name || "Error" : "_OTHER");
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  } else span.setStatus({ code: SpanStatusCode.ERROR });
}
