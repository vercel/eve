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

import {
  contentAttribute,
  messagesContentAttribute,
  systemPromptAttribute,
  textContentAttribute,
  toolResultsContentAttribute,
} from "#tracing/agent-otel-content.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { AgentSessionTraceState, AgentTraceStateStore } from "#tracing/agent-trace-state.js";
import type {
  InstrumentationAttemptMetadataEvent,
  InstrumentationAttemptScope,
  InstrumentationAttemptStartedEvent,
  InstrumentationAttemptTerminalEvent,
  InstrumentationContextRunner,
  InstrumentationModelCallTerminalEvent,
  InstrumentationModelCallStartedEvent,
  InstrumentationProviderDefinition,
  InstrumentationSessionStartedEvent,
  InstrumentationParentLineage,
  InstrumentationTraceContext,
  InstrumentationSessionTransitionEvent,
  InstrumentationToolCallStartedEvent,
  InstrumentationToolCallTerminalEvent,
  InstrumentationTurnStartedEvent,
  InstrumentationTurnTerminalEvent,
} from "#harness/instrumentation-lifecycle.js";

interface SpanState {
  readonly context: Context;
  readonly span: Span;
}

interface AttemptSpanState {
  readonly operation: SpanState & { readonly name: string };
  readonly step: SpanState;
}

interface ToolSpanState extends SpanState {
  readonly toolSpan: Span;
}

/** Sized so an ordinary session stays one trace and only an outsized one rolls. */
export const SESSION_WINDOW_TURN_LIMIT = 200;

export interface AgentOtelInstrumentationInput {
  /**
   * Capture model prompts/responses and tool call inputs/outputs as span
   * attributes. Content stays on the local machine — this provider only
   * wires the dev-time local spool — but can be turned off per project.
   */
  readonly captureContent?: boolean;
  readonly frameworkVersion: string;
  /**
   * Must be the registered tracer provider's id generator, so a turn span
   * emitted at its terminal carries the pre-allocated id (see
   * {@link AgentSpanIdGenerator}).
   */
  readonly idGenerator: AgentSpanIdGenerator;
  readonly stateStore: AgentTraceStateStore;
  readonly tracer: Tracer;
}

/** OTel event definition and its trusted framework context runner. */
export interface AgentOtelInstrumentation {
  readonly hook: InstrumentationProviderDefinition;
  readonly runInContext: InstrumentationContextRunner;
}

/** Creates OTel instrumentation for eve's structural `agent.*` convention. */
export function createAgentOtelInstrumentation(
  input: AgentOtelInstrumentationInput,
): AgentOtelInstrumentation {
  const captureContent = input.captureContent ?? true;
  const executionContexts = new WeakMap<
    InstrumentationAttemptScope,
    { readonly models: Map<string, Context>; readonly tools: Map<string, Context> }
  >();
  // A serverless turn runs inside one `turnStep` "use step" invocation. If
  // that worker is lost, Workflow retries the whole step from entry rather
  // than resuming this callback sequence in a replacement process.
  const steps = new WeakMap<InstrumentationAttemptScope, AttemptSpanState>();

  const onSessionStarted = async (event: InstrumentationSessionStartedEvent): Promise<void> => {
    await ensureSessionContext(event);
  };

  const onTurnStarted = async (event: InstrumentationTurnStartedEvent): Promise<void> => {
    const session = advanceSessionWindow(
      event.sessionId,
      await ensureSessionContext({
        agentName: undefined,
        channelKind: undefined,
        parentTraceContext: event.parentTraceContext,
        rootSessionId: event.rootSessionId,
        sessionId: event.sessionId,
        type: "session.started",
      }),
    );
    // The turn outlives this worker, so no live span can cover it: the span
    // id is allocated now for descendants to parent through, and the span
    // itself is emitted at the turn's session transition.
    const turnContext: SpanContext = {
      isRemote: false,
      spanId: input.idGenerator.allocateSpanId(),
      traceFlags: session.context.traceFlags,
      traceId: session.context.traceId,
    };
    await input.stateStore.setSession(event.sessionId, {
      ...session,
      turnsInWindow: session.turnsInWindow + 1,
    });
    await input.stateStore.setTurn(event.sessionId, event.turnId, {
      context: turnContext,
      lineage: event.parentLineage,
      parentSpanId: session.context.spanId,
      rootSessionId: event.rootSessionId,
      sequence: event.sequence,
      startTimeMs: Date.now(),
    });
  };

  const onAttemptStarted = async (event: InstrumentationAttemptStartedEvent): Promise<void> => {
    const turn = await input.stateStore.getTurn(event.scope.sessionId, event.scope.turnId);
    if (turn === undefined) return;
    const turnContext = contextFromSpanContext(turn.context);
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
          "gen_ai.operation.name": operationName,
          "gen_ai.provider.name": event.operation.provider,
          "gen_ai.request.model": event.operation.modelId,
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
  };

  const onAttemptTerminal = (event: InstrumentationAttemptTerminalEvent): void => {
    executionContexts.delete(event.scope);
    const attempt = steps.get(event.scope);
    if (attempt === undefined) return;
    attempt.step.span.addEvent(
      event.type === "attempt.completed" ? "step.completed" : "step.failed",
    );
    if (event.type === "attempt.failed") {
      recordError(attempt.operation.span, event.error);
      recordError(attempt.step.span, event.error);
    }
    attempt.operation.span.end();
    attempt.step.span.end();
    steps.delete(event.scope);
  };

  const onTurnTerminal = async (event: InstrumentationTurnTerminalEvent): Promise<void> => {
    const turn = await input.stateStore.getTurn(event.sessionId, event.turnId);
    if (turn === undefined) return;
    await input.stateStore.setTurn(event.sessionId, event.turnId, {
      ...turn,
      terminal: { error: event.error, type: event.type },
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
              isRemote: false,
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
        span.addEvent(event.type);
        span.end();
        await input.stateStore.deleteTurn(event.sessionId, event.turnId);
      }
    }
    // `session.waiting` is not terminal — the session may resume with a new
    // turn that still needs its metadata — so only release session-scoped
    // state on terminal transitions.
    if (event.type === "session.completed" || event.type === "session.failed") {
      await input.stateStore.deleteSession(event.sessionId);
    }
  };

  const beforeModelCall = (event: InstrumentationModelCallStartedEvent): SpanState | undefined => {
    const attempt = steps.get(event.scope);
    if (attempt === undefined) return undefined;
    attempt.step.span.setAttribute("agent.model.id", event.source.modelId);
    attempt.step.span.setAttribute("agent.model.provider", event.source.provider);
    const span = input.tracer.startSpan(
      modelSpanName(attempt.operation.name),
      {
        attributes: {
          "gen_ai.operation.name": attempt.operation.name,
          "gen_ai.provider.name": event.source.provider,
          "gen_ai.request.model": event.source.modelId,
        },
      },
      attempt.operation.context,
    );
    if (captureContent) {
      const messages = messagesContentAttribute(event.source.messages);
      if (messages !== undefined) span.setAttribute("ai.prompt.messages", messages);
      const system = systemPromptAttribute(event.source.instructions);
      if (system !== undefined) span.setAttribute("ai.prompt.system", system);
    }
    const state = { context: trace.setSpan(attempt.operation.context, span), span };
    getExecutionContexts(event.scope).models.set(event.id, state.context);
    return state;
  };

  const afterModelCall = (event: InstrumentationModelCallTerminalEvent, state: unknown): void => {
    executionContexts.get(event.scope)?.models.delete(event.id);
    if (!isSpanState(state)) return;
    if (event.type === "model.call.failed") {
      recordError(state.span, event.error);
    } else {
      setUsage(state.span, event.source.usage);
      const attempt = steps.get(event.scope);
      if (attempt !== undefined) setUsage(attempt.step.span, event.source.usage);
      if (captureContent) {
        state.span.setAttribute("ai.response.finish_reason", event.source.finishReason);
        const reasoning = textContentAttribute(
          event.source.content
            .filter((part) => part.type === "reasoning")
            .map((part) => part.text)
            .filter((part) => part.trim().length > 0)
            .join("\n"),
        );
        if (reasoning !== undefined) state.span.setAttribute("ai.response.reasoning", reasoning);
        const text = textContentAttribute(
          event.source.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        );
        if (text !== undefined) state.span.setAttribute("ai.response.text", text);
        const toolCalls = event.source.content
          .filter((part) => part.type === "tool-call")
          .map((part) => ({ input: part.input, toolName: part.toolName }));
        if (toolCalls.length > 0) {
          const json = contentAttribute(toolCalls, false);
          if (json !== undefined) state.span.setAttribute("ai.response.tool_calls", json);
        }
        // Provider-executed tools (e.g. web_search) run inside the model call,
        // never reach eve's tool loop, and so never get an ai.toolCall span.
        // Their results only exist as content parts on the model response.
        const toolResults = event.source.content
          .filter((part) => part.type === "tool-result" || part.type === "tool-error")
          .map((part) =>
            part.type === "tool-result"
              ? { input: part.input, output: part.output, toolName: part.toolName }
              : { error: errorText(part.error), input: part.input, toolName: part.toolName },
          );
        if (toolResults.length > 0) {
          const json = toolResultsContentAttribute(toolResults);
          if (json !== undefined) state.span.setAttribute("ai.response.tool_results", json);
        }
      }
    }
    state.span.end();
  };

  const beforeToolCall = (
    event: InstrumentationToolCallStartedEvent,
  ): ToolSpanState | undefined => {
    const attempt = steps.get(event.scope);
    if (attempt === undefined) return undefined;
    const actionSpan = input.tracer.startSpan(
      "agent.action",
      {
        attributes: {
          "agent.action.call_id": event.source.toolCall.toolCallId,
          "agent.action.kind": "tool",
          "agent.action.name": event.source.toolCall.toolName,
          "agent.framework.name": "eve",
          "agent.framework.version": input.frameworkVersion,
          "agent.root.session.id": event.scope.rootSessionId ?? event.scope.sessionId,
          "agent.session.id": event.scope.sessionId,
          "agent.step.attempt": event.scope.attemptIndex,
          "agent.step.index": event.scope.stepIndex,
          "agent.turn.id": event.scope.turnId,
        },
      },
      attempt.step.context,
    );
    const actionContext = trace.setSpan(attempt.step.context, actionSpan);
    const toolSpan = input.tracer.startSpan(
      "ai.toolCall",
      {
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.call.id": event.source.toolCall.toolCallId,
          "gen_ai.tool.name": event.source.toolCall.toolName,
        },
      },
      actionContext,
    );
    if (captureContent) {
      const args = contentAttribute(event.source.toolCall.input, false);
      if (args !== undefined) toolSpan.setAttribute("gen_ai.tool.call.arguments", args);
    }
    const state: ToolSpanState = {
      context: trace.setSpan(actionContext, toolSpan),
      span: actionSpan,
      toolSpan,
    };
    getExecutionContexts(event.scope).tools.set(event.id, state.context);
    return state;
  };

  const afterToolCall = (event: InstrumentationToolCallTerminalEvent, state: unknown): void => {
    executionContexts.get(event.scope)?.tools.delete(event.id);
    if (!isToolSpanState(state)) return;
    if (event.type === "tool.call.failed") {
      recordError(state.toolSpan, event.error);
      recordError(state.span, event.error);
    } else if (event.source.toolOutput.type !== "tool-result") {
      recordError(state.toolSpan, event.source.toolOutput.error);
      recordError(state.span, event.source.toolOutput.error);
    } else if (captureContent) {
      const result = contentAttribute(event.source.toolOutput.output, false);
      if (result !== undefined) state.toolSpan.setAttribute("gen_ai.tool.call.result", result);
    }
    state.toolSpan.end();
    state.span.end();
  };

  const openSessionWindow = (window: {
    readonly agentName?: string;
    readonly index: number;
    readonly previousTraceId?: string;
    readonly rootSessionId: string;
    readonly sessionId: string;
  }): SpanContext => {
    const span = input.tracer.startSpan("agent.session", {
      attributes: {
        "agent.framework.name": "eve",
        "agent.framework.version": input.frameworkVersion,
        "agent.name": window.agentName,
        "agent.root.session.id": window.rootSessionId,
        "agent.session.id": window.sessionId,
        "agent.session.window": window.index,
        ...(window.previousTraceId === undefined
          ? {}
          : { "agent.session.window.previous.trace.id": window.previousTraceId }),
      },
      root: true,
    });
    span.addEvent(window.index === 0 ? "session.started" : "session.window.opened");
    // The window outlives this worker and has no guaranteed close — an idle
    // session never ends — so the root is recorded as a zero-duration marker
    // and later spans parent through its persisted context.
    span.end();
    return span.spanContext();
  };

  const ensureSessionContext = async (
    event: InstrumentationSessionStartedEvent,
  ): Promise<AgentSessionTraceState> => {
    let state = await input.stateStore.getSession(event.sessionId);
    if (state === undefined) {
      state = {
        agentName: event.agentName,
        channelKind: event.channelKind,
        context:
          event.parentTraceContext === undefined
            ? openSessionWindow({
                agentName: event.agentName,
                index: 0,
                rootSessionId: event.rootSessionId,
                sessionId: event.sessionId,
              })
            : adoptedSpanContext(event.parentTraceContext),
        rootSessionId: event.rootSessionId,
        turnsInWindow: 0,
        window: 0,
      };
      await input.stateStore.setSession(event.sessionId, state);
    }
    return state;
  };

  const advanceSessionWindow = (
    sessionId: string,
    session: AgentSessionTraceState,
  ): AgentSessionTraceState => {
    if (session.turnsInWindow < SESSION_WINDOW_TURN_LIMIT) return session;
    const index = session.window + 1;
    return {
      ...session,
      context: openSessionWindow({
        agentName: session.agentName,
        index,
        previousTraceId: session.context.traceId,
        rootSessionId: session.rootSessionId,
        sessionId,
      }),
      turnsInWindow: 0,
      window: index,
    };
  };

  const onAttemptMetadata = (event: InstrumentationAttemptMetadataEvent): void => {
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
      events: {
        "attempt.completed": onAttemptTerminal,
        "attempt.failed": onAttemptTerminal,
        "attempt.metadata": onAttemptMetadata,
        "attempt.started": onAttemptStarted,
        "model.call": { after: afterModelCall, before: beforeModelCall },
        "session.completed": onSessionTransition,
        "session.failed": onSessionTransition,
        "session.started": onSessionStarted,
        "session.waiting": onSessionTransition,
        "tool.call": { after: afterToolCall, before: beforeToolCall },
        "turn.cancelled": onTurnTerminal,
        "turn.completed": onTurnTerminal,
        "turn.failed": onTurnTerminal,
        "turn.started": onTurnStarted,
      },
    },
    runInContext(operation, execute) {
      const contexts = executionContexts.get(operation.scope);
      const parent =
        operation.type === "model.call"
          ? contexts?.models.get(operation.id)
          : contexts?.tools.get(operation.id);
      return parent === undefined ? execute() : context.with(parent, execute);
    },
  };

  function getExecutionContexts(scope: InstrumentationAttemptScope): {
    readonly models: Map<string, Context>;
    readonly tools: Map<string, Context>;
  } {
    let state = executionContexts.get(scope);
    if (state === undefined) {
      state = { models: new Map(), tools: new Map() };
      executionContexts.set(scope, state);
    }
    return state;
  }
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

function adoptedSpanContext(handed: InstrumentationTraceContext): SpanContext {
  return {
    // Not remote: a subagent crosses the same worker boundary every restored
    // session context does, not the wire.
    isRemote: false,
    spanId: handed.spanId,
    traceFlags: handed.traceFlags,
    traceId: handed.traceId,
  };
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

function isSpanState(value: unknown): value is SpanState {
  return typeof value === "object" && value !== null && "context" in value && "span" in value;
}

function isToolSpanState(value: unknown): value is ToolSpanState {
  return isSpanState(value) && "toolSpan" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelSpanName(operationName: string): string {
  return operationName === "ai.generateText"
    ? "ai.generateText.doGenerate"
    : "ai.streamText.doStream";
}

function setUsage(
  span: Span,
  usage: {
    readonly inputTokenDetails?: {
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
    };
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  },
): void {
  if (usage.inputTokens !== undefined) {
    span.setAttribute("agent.usage.input_tokens", usage.inputTokens);
  }
  if (usage.outputTokens !== undefined) {
    span.setAttribute("agent.usage.output_tokens", usage.outputTokens);
  }
  // Cached tokens price differently from plain input, so keep the split.
  // Named for the OTel GenAI semantic conventions; present only when the
  // provider reports details — others emit nothing.
  const details = usage.inputTokenDetails;
  if (details?.cacheReadTokens !== undefined) {
    span.setAttribute("gen_ai.usage.cache_read.input_tokens", details.cacheReadTokens);
  }
  if (details?.cacheWriteTokens !== undefined) {
    span.setAttribute("gen_ai.usage.cache_creation.input_tokens", details.cacheWriteTokens);
  }
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
