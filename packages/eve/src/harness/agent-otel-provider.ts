import {
  ROOT_CONTEXT,
  SpanStatusCode,
  context,
  type Context,
  type Span,
  type SpanContext,
  type Tracer,
  trace,
} from "@opentelemetry/api";

import type {
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
  // Attempt scopes are object identities retained by the bridge for one
  // atomic invocation; WeakMap state cannot outlive an abandoned attempt.
  const steps = new WeakMap<InstrumentationAttemptScope, SpanState>();

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
    const span = input.tracer.startSpan(
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
    span.addEvent("step.started");
    steps.set(event.scope, {
      context: trace.setSpan(turnContext, span),
      span,
    });
  };

  const onAttemptTerminal = (event: InstrumentationAttemptTerminalEvent): void => {
    executionContexts.delete(event.scope);
    const step = steps.get(event.scope);
    if (step === undefined) return;
    step.span.addEvent(event.type === "attempt.completed" ? "step.completed" : "step.failed");
    if (event.type === "attempt.failed") recordError(step.span, event.error);
    step.span.end();
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
    const step = steps.get(event.scope);
    if (step === undefined) return undefined;
    step.span.setAttribute("agent.model.id", event.source.modelId);
    step.span.setAttribute("agent.model.provider", event.source.provider);
    getExecutionContexts(event.scope).models.set(event.id, step.context);
    return step;
  };

  const afterModelCall = (event: InstrumentationModelCallTerminalEvent, state: unknown): void => {
    executionContexts.get(event.scope)?.models.delete(event.id);
    if (!isSpanState(state)) return;
    if (event.type === "model.call.failed") {
      recordError(state.span, event.error);
      return;
    }
    setUsage(state.span, event.source.usage);
  };

  const beforeToolCall = (event: InstrumentationToolCallStartedEvent): SpanState | undefined => {
    const step = steps.get(event.scope);
    if (step === undefined) return undefined;
    const span = input.tracer.startSpan(
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
      step.context,
    );
    const state = { context: trace.setSpan(step.context, span), span };
    getExecutionContexts(event.scope).tools.set(event.id, state.context);
    return state;
  };

  const afterToolCall = (event: InstrumentationToolCallTerminalEvent, state: unknown): void => {
    executionContexts.get(event.scope)?.tools.delete(event.id);
    if (!isSpanState(state)) return;
    if (event.type === "tool.call.failed") {
      recordError(state.span, event.error);
    } else if (event.source.toolOutput.type !== "tool-result") {
      recordError(state.span, event.source.toolOutput.error);
    }
    state.span.end();
  };

  const ensureSessionContext = async (
    event: InstrumentationSessionStartedEvent,
  ): Promise<AgentSessionTraceState> => {
    let state = await input.stateStore.getSession(event.sessionId);
    if (state === undefined) {
      const marker = input.tracer.startSpan(
        "agent.session",
        {
          attributes: {
            "agent.channel.kind": event.channelKind,
            "agent.framework.name": "eve",
            "agent.framework.version": input.frameworkVersion,
            "agent.name": event.agentName,
            "agent.root.session.id": event.rootSessionId,
            "agent.session.id": event.sessionId,
          },
          root: true,
        },
        ROOT_CONTEXT,
      );
      state = {
        agentName: event.agentName,
        channelKind: event.channelKind,
        context: marker.spanContext(),
        pendingStarted: true,
        rootSessionId: event.rootSessionId,
      };
      await input.stateStore.setSession(event.sessionId, state);
      marker.end();
    }
    return state;
  };

  return {
    hook: {
      events: {
        "attempt.completed": onAttemptTerminal,
        "attempt.failed": onAttemptTerminal,
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

function contextFromSpanContext(spanContext: SpanContext): Context {
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext));
}

function isSpanState(value: unknown): value is SpanState {
  return typeof value === "object" && value !== null && "context" in value && "span" in value;
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
