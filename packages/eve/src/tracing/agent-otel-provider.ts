import {
  ROOT_CONTEXT,
  SpanStatusCode,
  context,
  type Context,
  type Span,
  type SpanContext,
  type Tracer,
  trace,
} from "#compiled/@opentelemetry/api/index.js";

import type { AgentTraceStateStore } from "#tracing/agent-trace-state.js";
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
import { setAgentUsage } from "#tracing/agent-otel-usage.js";
import { createAgentOtelSessionContext } from "#tracing/agent-otel-session-context.js";
import type {
  InstrumentationStepAttemptMetadataEvent,
  InstrumentationAttemptScope,
  InstrumentationStepAttemptStartedEvent,
  InstrumentationStepAttemptTerminalEvent,
  InstrumentationContextRunner,
  InstrumentationModelCallTerminalEvent,
  InstrumentationModelCallStartedEvent,
  InstrumentationProviderDefinition,
  InstrumentationSessionStartedEvent,
  InstrumentationParentLineage,
  InstrumentationTraceContext,
  InstrumentationSessionTransitionEvent,
  InstrumentationTurnStartedEvent,
  InstrumentationTurnTerminalEvent,
} from "#harness/instrumentation/lifecycle.js";

interface SpanState {
  readonly context: Context;
  readonly span: Span;
}

interface AttemptSpanState {
  readonly operation: SpanState & { readonly name: string };
  readonly step: SpanState;
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
}

/** OTel event definition and its trusted framework context runner. */
export interface AgentOtelInstrumentation {
  readonly hook: InstrumentationProviderDefinition;
  readonly prepareSessionTrace: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<InstrumentationTraceContext>;
  readonly prepareTurnTrace: (
    event: InstrumentationTurnStartedEvent,
  ) => Promise<InstrumentationTraceContext>;
  readonly runInContext: InstrumentationContextRunner;
}

/** Creates OTel instrumentation for eve's structural `agent.*` convention. */
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
  const steps = new WeakMap<InstrumentationAttemptScope, AttemptSpanState>();
  const modelSpans = new WeakMap<InstrumentationAttemptScope, Map<string, SpanState>>();
  const actions = createAgentActionInstrumentation({
    frameworkVersion: input.frameworkVersion,
    idGenerator: input.idGenerator,
    recordInputs,
    recordOutputs,
    resolveParent: async (event) => {
      const turn = await input.stateStore.getTurn(event.scope.sessionId, event.scope.turnId);
      return turn === undefined
        ? undefined
        : { context: contextFromSpanContext(turn.context), spanContext: turn.context };
    },
    stateStore: input.stateStore,
    tracer: input.tracer,
  });
  const approvals = createAgentApprovalInstrumentation({
    actionContextFor: actions.contextFor,
    frameworkVersion: input.frameworkVersion,
    idGenerator: input.idGenerator,
    recordInputs,
    recordOutputs,
    tracer: input.tracer,
  });
  const tools = createAgentToolInstrumentation({
    actionContextFor: actions.contextFor,
    idGenerator: input.idGenerator,
    recordInputs,
    recordOutputs,
    resolveFallback: (event) => {
      const scope = attemptScopes.get(event.scope.attemptId) ?? event.scope;
      const step = steps.get(scope)?.step;
      return step === undefined
        ? undefined
        : { context: step.context, spanContext: step.span.spanContext() };
    },
    tracer: input.tracer,
  });
  const { ensureSessionContext, prepareSessionTrace, prepareTurnTrace } =
    createAgentOtelSessionContext(input);

  const onSessionStarted = async (event: InstrumentationSessionStartedEvent): Promise<void> => {
    await prepareSessionTrace(event);
  };

  const onTurnStarted = async (event: InstrumentationTurnStartedEvent): Promise<void> => {
    await prepareTurnTrace(event);
  };

  const onStepStarted = async (event: InstrumentationStepAttemptStartedEvent): Promise<void> => {
    const turn = await input.stateStore.getTurn(event.scope.sessionId, event.scope.turnId);
    if (turn === undefined) return;
    const turnContext = contextFromSpanContext(turn.context);
    const activeSpanContext = trace.getSpan(context.active())?.spanContext();
    const stepSpan = input.tracer.startSpan(
      "agent.step",
      {
        attributes: {
          "agent.session.id": event.scope.sessionId,
          "agent.framework.name": "eve",
          "agent.framework.version": input.frameworkVersion,
          "agent.root.session.id": event.scope.rootSessionId ?? event.scope.sessionId,
          "agent.step.attempt": event.scope.attemptIndex,
          "agent.step.index": event.scope.stepIndex,
          "agent.turn.id": event.scope.turnId,
          "agent.name": event.scope.functionId,
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
    );
    stepSpan.addEvent("step.started");
    const stepContext = trace.setSpan(turnContext, stepSpan);
    const operationName = event.operation.operationId;
    const operationSpan = input.tracer.startSpan(
      operationName,
      {
        attributes: {
          "ai.operation.name": operationName,
          "ai.provider.name": event.operation.provider,
          "ai.request.model": event.operation.modelId,
        },
      },
      stepContext,
    );
    steps.set(event.scope, {
      operation: {
        context: trace.setSpan(stepContext, operationSpan),
        name: operationName,
        span: operationSpan,
      },
      step: { context: stepContext, span: stepSpan },
    });
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
    attempt.step.span.addEvent(
      event.type === "step.attempt.completed" ? "step.completed" : "step.failed",
    );
    if (event.type === "step.attempt.failed") {
      recordError(attempt.operation.span, event.error);
      recordError(attempt.step.span, event.error);
    }
    attempt.operation.span.end();
    attempt.step.span.end();
    steps.delete(scope);
  };

  const onTurnTerminal = async (event: InstrumentationTurnTerminalEvent): Promise<void> => {
    if (event.type === "turn.cancelled" || event.type === "turn.failed") {
      await actions.deleteForTurn(event.sessionId, event.turnId);
    }
    const turn = await input.stateStore.getTurn(event.sessionId, event.turnId);
    if (turn === undefined) return;
    await input.stateStore.setTurn(event.sessionId, event.turnId, {
      ...turn,
      terminal:
        event.type === "turn.failed"
          ? { error: event.error, type: event.type }
          : { type: event.type },
    });
  };

  const onSessionTransition = async (
    event: InstrumentationSessionTransitionEvent,
  ): Promise<void> => {
    if (event.turnId !== undefined) {
      const turn = await input.stateStore.getTurn(event.sessionId, event.turnId);
      if (turn !== undefined) {
        const session = await input.stateStore.getSession(event.sessionId);
        const span = input.idGenerator.withSpanId(turn.context.spanId, () =>
          input.tracer.startSpan(
            "agent.turn",
            {
              attributes: {
                "agent.framework.name": "eve",
                "agent.framework.version": input.frameworkVersion,
                "agent.name": session?.agentName,
                ...parentLineageAttributes(turn.lineage),
                "agent.root.session.id": turn.rootSessionId,
                "agent.session.id": event.sessionId,
                "agent.session.window": session?.window,
                "agent.turn.id": event.turnId,
                "agent.turn.sequence": turn.sequence,
              },
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
        span.addEvent("turn.started", undefined, turn.startTimeMs);
        if (turn.terminal !== undefined) {
          span.addEvent(turn.terminal.type);
          if (turn.terminal.type === "turn.failed") {
            recordError(span, turn.terminal.error);
          }
        }
        span.end();
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
    attempt.step.span.setAttribute("agent.model.id", event.model.modelId);
    attempt.step.span.setAttribute("agent.model.provider", event.model.provider);
    const span = input.tracer.startSpan(
      modelSpanName(event.model.modelId),
      {
        attributes: {
          "gen_ai.agent.name": event.scope.functionId,
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": event.model.provider,
          "gen_ai.request.model": event.model.modelId,
        },
      },
      attempt.operation.context,
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
    const state = { context: trace.setSpan(attempt.operation.context, span), span };
    getExecutionContexts(event.scope).set(event.idempotencyKey, state.context);
    getSpanStates(modelSpans, event.scope).set(event.idempotencyKey, state);
  };

  const onModelCallTerminal = (event: InstrumentationModelCallTerminalEvent): void => {
    executionContexts.get(event.scope)?.delete(event.idempotencyKey);
    const state = takeSpanState(modelSpans, event.scope, event.idempotencyKey);
    if (state === undefined) return;
    if (event.type === "model.call.failed") {
      recordError(state.span, event.error);
    } else {
      setAgentUsage(state.span, event.usage);
      state.span.setAttribute("gen_ai.response.finish_reasons", [event.finishReason]);
      const attempt = steps.get(event.scope);
      if (attempt !== undefined) setAgentUsage(attempt.step.span, event.usage);
      if (recordOutputs) {
        state.span.setAttribute("ai.response.finish_reason", event.finishReason);
        const content = event.content ?? [];
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
        // never reach eve's tool loop, and so never get an ai.toolCall span.
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
      attempt.step.span.setAttribute(key, value);
    }
  };

  return {
    hook: {
      // The destinations behind this pipeline filter content per exporter, but
      // that filter only runs on a span that has it. Declining both here is
      // what stops the projection from being built upstream.
      capture: recordInputs || recordOutputs ? "content" : "metadata",
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
    },
    prepareSessionTrace,
    prepareTurnTrace,
    runInContext(operation, execute) {
      const scope = attemptScopes.get(operation.scope.attemptId) ?? operation.scope;
      const contexts = executionContexts.get(scope);
      const parent =
        operation.type === "model.call"
          ? contexts?.get(operation.idempotencyKey)
          : tools.contextFor(operation.scope.attemptId, operation.idempotencyKey);
      return parent === undefined ? execute() : context.with(parent, execute);
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

function parentLineageAttributes(
  lineage: InstrumentationParentLineage | undefined,
): Record<string, string> {
  if (lineage === undefined) return {};
  const attributes: Record<string, string> = {
    "agent.parent.call_id": lineage.callId,
    "agent.parent.session.id": lineage.sessionId,
    "agent.parent.turn.id": lineage.turnId,
  };
  if (lineage.subagentName !== undefined) {
    attributes["agent.subagent.name"] = lineage.subagentName;
  }
  return attributes;
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

function errorText(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}

function recordError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  } else span.setStatus({ code: SpanStatusCode.ERROR });
}
