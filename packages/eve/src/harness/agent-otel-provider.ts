import { createHash } from "node:crypto";

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

export interface AgentSessionTraceState {
  readonly agentName?: string;
  readonly channelKind?: string;
  readonly context: SpanContext;
  readonly pendingStarted: boolean;
  readonly rootSessionId: string;
}

export interface AgentTurnTraceState {
  readonly context: SpanContext;
  readonly rootSessionId: string;
  readonly sequence: number;
  readonly terminal?: {
    readonly error?: unknown;
    readonly type: InstrumentationTurnTerminalEvent["type"];
  };
}

/** Provider-owned serializable storage for durable agent trace state. */
export interface AgentTraceStateStore {
  deleteSession(sessionId: string): void | PromiseLike<void>;
  deleteTurn(sessionId: string, turnId: string): void | PromiseLike<void>;
  getSession(
    sessionId: string,
  ): AgentSessionTraceState | undefined | PromiseLike<AgentSessionTraceState | undefined>;
  getTurn(
    sessionId: string,
    turnId: string,
  ): AgentTurnTraceState | undefined | PromiseLike<AgentTurnTraceState | undefined>;
  setSession(sessionId: string, state: AgentSessionTraceState): void | PromiseLike<void>;
  setTurn(sessionId: string, turnId: string, state: AgentTurnTraceState): void | PromiseLike<void>;
}

/** In-memory trace state used by tests and non-durable runtimes. */
export class InMemoryAgentTraceStateStore implements AgentTraceStateStore {
  readonly #sessions = new Map<string, AgentSessionTraceState>();
  readonly #turns = new Map<string, AgentTurnTraceState>();

  deleteSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  deleteTurn(sessionId: string, turnId: string): void {
    this.#turns.delete(turnKey(sessionId, turnId));
  }

  getSession(sessionId: string): AgentSessionTraceState | undefined {
    return this.#sessions.get(sessionId);
  }

  getTurn(sessionId: string, turnId: string): AgentTurnTraceState | undefined {
    return this.#turns.get(turnKey(sessionId, turnId));
  }

  setSession(sessionId: string, state: AgentSessionTraceState): void {
    this.#sessions.set(sessionId, state);
  }

  setTurn(sessionId: string, turnId: string, state: AgentTurnTraceState): void {
    this.#turns.set(turnKey(sessionId, turnId), state);
  }
}

export interface AgentOtelInstrumentationInput {
  readonly frameworkVersion: string;
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
    const session = await ensureSessionContext({
      agentName: undefined,
      channelKind: undefined,
      rootSessionId: event.rootSessionId,
      sessionId: event.sessionId,
      type: "session.started",
    });
    const span = input.tracer.startSpan(
      "agent.turn",
      {
        attributes: {
          "agent.framework.name": "eve",
          "agent.framework.version": input.frameworkVersion,
          "agent.name": session.agentName,
          "agent.root.session.id": event.rootSessionId,
          "agent.session.id": event.sessionId,
          "agent.turn.id": event.turnId,
          "agent.turn.sequence": event.sequence,
        },
      },
      contextFromSpanContext(session.context),
    );
    span.addEvent("turn.started");
    if (session.pendingStarted) {
      span.addEvent("session.started");
    }
    await input.stateStore.setSession(event.sessionId, {
      ...session,
      pendingStarted: false,
    });
    await input.stateStore.setTurn(event.sessionId, event.turnId, {
      context: span.spanContext(),
      rootSessionId: event.rootSessionId,
      sequence: event.sequence,
    });
    span.end();
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
        const span = input.tracer.startSpan(
          "agent.turn.terminal",
          {
            attributes: {
              "agent.root.session.id": turn.rootSessionId,
              "agent.session.id": event.sessionId,
              "agent.turn.id": event.turnId,
              "agent.turn.sequence": turn.sequence,
            },
          },
          contextFromSpanContext(turn.context),
        );
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
    }
    state.toolSpan.end();
    state.span.end();
  };

  const ensureSessionContext = async (
    event: InstrumentationSessionStartedEvent,
  ): Promise<AgentSessionTraceState> => {
    let state = await input.stateStore.getSession(event.sessionId);
    if (state === undefined) {
      state = {
        agentName: event.agentName,
        channelKind: event.channelKind,
        context: sessionTraceContext(event.sessionId),
        pendingStarted: true,
        rootSessionId: event.rootSessionId,
      };
      await input.stateStore.setSession(event.sessionId, state);
    }
    return state;
  };

  const onAttemptMetadata = (event: InstrumentationAttemptMetadataEvent): void => {
    const attempt = steps.get(event.scope);
    if (attempt === undefined) return;
    // Vercel AI Gateway reports per-call cost in providerMetadata.gateway;
    // attributes exist only when it was actually the gateway serving the call.
    const gateway = readGatewayCost(event.providerMetadata);
    if (gateway === undefined) return;
    for (const [key, value] of Object.entries(gateway)) {
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

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

function sessionTraceContext(sessionId: string): SpanContext {
  return {
    spanId: digestId(`eve:session-parent:${sessionId}`, 16),
    traceFlags: 1,
    traceId: digestId(`eve:session:${sessionId}`, 32),
  };
}

function digestId(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
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
  usage: { readonly inputTokens?: number; readonly outputTokens?: number },
): void {
  if (usage.inputTokens !== undefined) {
    span.setAttribute("agent.usage.input_tokens", usage.inputTokens);
  }
  if (usage.outputTokens !== undefined) {
    span.setAttribute("agent.usage.output_tokens", usage.outputTokens);
  }
}

function recordError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  } else {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
}
