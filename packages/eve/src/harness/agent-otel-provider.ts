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
  InstrumentationAttemptStartedEvent,
  InstrumentationAttemptTerminalEvent,
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

interface SessionMetadata {
  readonly agentName?: string;
  readonly channelKind?: string;
  readonly rootSessionId: string;
}

/** Provider-owned storage for the trace context assigned to an eve session. */
export interface AgentSessionContextStore {
  get(sessionId: string): SpanContext | undefined;
  set(sessionId: string, spanContext: SpanContext): void;
}

/** In-memory context storage used by tests and non-durable runtimes. */
export class InMemoryAgentSessionContextStore implements AgentSessionContextStore {
  readonly #contexts = new Map<string, SpanContext>();

  get(sessionId: string): SpanContext | undefined {
    return this.#contexts.get(sessionId);
  }

  set(sessionId: string, spanContext: SpanContext): void {
    this.#contexts.set(sessionId, spanContext);
  }
}

export interface AgentOtelProviderInput {
  readonly frameworkVersion: string;
  readonly sessionContexts: AgentSessionContextStore;
  readonly tracer: Tracer;
}

/** Creates the OTel lifecycle provider for eve's structural `agent.*` convention. */
export function createAgentOtelProvider(
  input: AgentOtelProviderInput,
): InstrumentationProviderDefinition {
  const actions = new Map<string, SpanState>();
  const modelContexts = new Map<string, Context>();
  const pendingSessionStarted = new Set<string>();
  const sessionMetadata = new Map<string, SessionMetadata>();
  const steps = new Map<string, SpanState>();
  const turns = new Map<string, SpanState>();

  const onSessionStarted = (event: InstrumentationSessionStartedEvent): void => {
    sessionMetadata.set(event.sessionId, event);
    if (ensureSessionContext(event).created) pendingSessionStarted.add(event.sessionId);
  };

  const onTurnStarted = (event: InstrumentationTurnStartedEvent): void => {
    const session = ensureSessionContext({
      agentName: undefined,
      channelKind: undefined,
      rootSessionId: event.rootSessionId,
      sessionId: event.sessionId,
      type: "session.started",
    });
    const metadata = sessionMetadata.get(event.sessionId);
    const span = input.tracer.startSpan(
      "agent.turn",
      {
        attributes: {
          "agent.framework.name": "eve",
          "agent.framework.version": input.frameworkVersion,
          "agent.name": metadata?.agentName,
          "agent.root.session.id": event.rootSessionId,
          "agent.session.id": event.sessionId,
          "agent.turn.id": event.turnId,
          "agent.turn.sequence": event.sequence,
        },
      },
      session.context,
    );
    span.addEvent("turn.started");
    if (pendingSessionStarted.delete(event.sessionId)) {
      span.addEvent("session.started");
    }
    turns.set(turnKey(event.sessionId, event.turnId), {
      context: trace.setSpan(session.context, span),
      span,
    });
  };

  const onAttemptStarted = (event: InstrumentationAttemptStartedEvent): void => {
    const turn = turns.get(turnKey(event.scope.sessionId, event.scope.turnId));
    if (turn === undefined) return;
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
      turn.context,
    );
    span.addEvent("step.started");
    steps.set(event.scope.attemptId, {
      context: trace.setSpan(turn.context, span),
      span,
    });
  };

  const onAttemptTerminal = (event: InstrumentationAttemptTerminalEvent): void => {
    const step = steps.get(event.scope.attemptId);
    if (step === undefined) return;
    step.span.addEvent(event.type === "attempt.completed" ? "step.completed" : "step.failed");
    if (event.type === "attempt.failed") recordError(step.span, event.error);
    step.span.end();
    steps.delete(event.scope.attemptId);
  };

  const onTurnTerminal = (event: InstrumentationTurnTerminalEvent): void => {
    const turn = turns.get(turnKey(event.sessionId, event.turnId));
    if (turn === undefined) return;
    turn.span.addEvent(event.type);
    if (event.type === "turn.failed") recordError(turn.span, event.error);
  };

  const onSessionTransition = (event: InstrumentationSessionTransitionEvent): void => {
    if (event.turnId !== undefined) {
      const key = turnKey(event.sessionId, event.turnId);
      const turn = turns.get(key);
      if (turn !== undefined) {
        turn.span.addEvent(event.type);
        turn.span.end();
        turns.delete(key);
      }
    }
    // `session.waiting` is not terminal — the session may resume with a new
    // turn that still needs its metadata — so only release session-scoped
    // state on terminal transitions.
    if (event.type === "session.completed" || event.type === "session.failed") {
      sessionMetadata.delete(event.sessionId);
      pendingSessionStarted.delete(event.sessionId);
    }
  };

  const beforeModelCall = (event: InstrumentationModelCallStartedEvent): SpanState | undefined => {
    const step = steps.get(event.scope.attemptId);
    if (step === undefined) return undefined;
    step.span.setAttribute("agent.model.id", event.source.modelId);
    step.span.setAttribute("agent.model.provider", event.source.provider);
    modelContexts.set(event.id, step.context);
    return step;
  };

  const afterModelCall = (event: InstrumentationModelCallTerminalEvent, state: unknown): void => {
    modelContexts.delete(event.id);
    if (!isSpanState(state)) return;
    if (event.type === "model.call.failed") {
      recordError(state.span, event.error);
      return;
    }
    setUsage(state.span, event.source.usage);
  };

  const beforeToolCall = (event: InstrumentationToolCallStartedEvent): SpanState | undefined => {
    const step = steps.get(event.scope.attemptId);
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
    actions.set(event.id, state);
    return state;
  };

  const afterToolCall = (event: InstrumentationToolCallTerminalEvent, state: unknown): void => {
    actions.delete(event.id);
    if (!isSpanState(state)) return;
    if (event.type === "tool.call.failed") {
      recordError(state.span, event.error);
    } else if (event.source.toolOutput.type !== "tool-result") {
      recordError(state.span, event.source.toolOutput.error);
    }
    state.span.end();
  };

  const ensureSessionContext = (
    event: InstrumentationSessionStartedEvent,
  ): { context: Context; created: boolean } => {
    let spanContext = input.sessionContexts.get(event.sessionId);
    let created = false;
    if (spanContext === undefined) {
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
      spanContext = marker.spanContext();
      input.sessionContexts.set(event.sessionId, spanContext);
      marker.end();
      created = true;
    }
    return {
      context: trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext)),
      created,
    };
  };

  return {
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
    executionContext: {
      runModelCall(id, execute) {
        const parent = modelContexts.get(id);
        return parent === undefined ? execute() : context.with(parent, execute);
      },
      runToolCall(id, execute) {
        const parent = actions.get(id)?.context;
        return parent === undefined ? execute() : context.with(parent, execute);
      },
    },
  };
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
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
