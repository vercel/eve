import {
  ROOT_CONTEXT,
  SpanStatusCode,
  type Context,
  type Span,
  type SpanContext,
  type Tracer,
  trace,
} from "#compiled/@opentelemetry/api/index.js";

import type {
  InstrumentationActionStartedEvent,
  InstrumentationActionTerminalEvent,
  InstrumentationAttemptScope,
  InstrumentationProviderDefinition,
} from "#harness/instrumentation/lifecycle.js";
import { actionIdempotencyKey, attemptIdempotencyKey } from "#harness/instrumentation/lifecycle.js";
import { contentAttribute } from "#tracing/agent-otel-content.js";
import { vercelSessionIdAttribute } from "#tracing/agent-otel-attributes.js";
import { setAgentUsage } from "#tracing/agent-otel-usage.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { AgentActionTraceState, AgentTraceStateStore } from "#tracing/agent-trace-state.js";
import { isSampledTrace } from "#tracing/sampled-trace.js";

export interface AgentActionInstrumentation {
  readonly events: Pick<
    NonNullable<InstrumentationProviderDefinition["events"]>,
    "action.completed" | "action.failed" | "action.started"
  >;
  deleteForSession(sessionId: string): void | PromiseLike<void>;
  deleteForTurn(sessionId: string, turnId: string): void | PromiseLike<void>;
  failForAttempt(scope: InstrumentationAttemptScope, error: unknown): Promise<void>;
  contextFor(
    sessionId: string,
    turnId: string,
    callId: string,
  ): Promise<AgentActionContext | undefined>;
}

export interface AgentActionContext {
  readonly context: Context;
  readonly spanContext: SpanContext;
}

/** Builds durable `agent.action` spans around eve's runtime dispatch boundary. */
export function createAgentActionInstrumentation(input: {
  readonly emitVercelSessionId?: boolean;
  readonly frameworkVersion: string;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly resolveTraceContext: (
    event: InstrumentationActionStartedEvent,
  ) => SpanContext | undefined | PromiseLike<SpanContext | undefined>;
  readonly stateStore: AgentTraceStateStore;
  readonly tracer: Tracer;
}): AgentActionInstrumentation {
  const emitVercelSessionId = input.emitVercelSessionId ?? false;
  const byAttempt = new Map<string, Set<string>>();

  const onStarted = async (event: InstrumentationActionStartedEvent): Promise<void> => {
    const traceContext = await input.resolveTraceContext(event);
    if (traceContext === undefined || !isSampledTrace(traceContext)) return;

    const existing = await input.stateStore.getAction(event.idempotencyKey);
    const state: AgentActionTraceState = existing ?? {
      attemptIndex: event.scope.attemptIndex,
      callId: event.callId,
      inputAttribute: input.recordInputs ? contentAttribute(event.input, false) : undefined,
      kind: event.kind,
      name: event.name,
      parent: {
        spanId: input.idGenerator.deriveSpanId(attemptIdempotencyKey(event.scope)),
        traceFlags: traceContext.traceFlags,
        traceId: traceContext.traceId,
      },
      rootSessionId: event.scope.rootSessionId ?? event.scope.sessionId,
      sessionId: event.scope.sessionId,
      spanId: input.idGenerator.deriveSpanId(`action:${event.idempotencyKey}`),
      startTimeMs: Date.now(),
      stepIndex: event.scope.stepIndex,
      turnId: event.scope.turnId,
    };
    await input.stateStore.setAction(event.idempotencyKey, state);
    const keys = byAttempt.get(event.scope.attemptId) ?? new Set<string>();
    keys.add(event.idempotencyKey);
    byAttempt.set(event.scope.attemptId, keys);
  };

  const onTerminal = async (event: InstrumentationActionTerminalEvent): Promise<void> => {
    const state = await input.stateStore.getAction(event.idempotencyKey);
    if (state === undefined) return;
    try {
      const span = startSpan(state);
      span.setAttribute("agent.action.outcome", event.outcome);
      if (event.type === "action.failed") {
        if (event.errorCode !== undefined) {
          span.setAttribute("agent.action.error.code", event.errorCode);
          span.setAttribute("error.type", event.errorCode);
        }
        recordError(span, event.error);
      } else if (event.output.type === "error") {
        recordError(span, event.output.error);
      } else {
        if (event.usage !== undefined) setAgentUsage(span, event.usage);
        if (input.recordOutputs) {
          const result = contentAttribute(event.output.output, false);
          if (result !== undefined) span.setAttribute("gen_ai.tool.call.result", result);
        }
      }
      span.end(event.acceptedAtMs);
    } finally {
      await input.stateStore.deleteAction(event.idempotencyKey);
      forget(event.idempotencyKey);
    }
  };

  const startSpan = (state: AgentActionTraceState): Span => {
    const span = input.idGenerator.withSpanId(state.spanId, () =>
      input.tracer.startSpan(
        "agent.action",
        {
          attributes: {
            "agent.action.call_id": state.callId,
            "agent.action.kind": state.kind,
            "agent.action.name": state.name,
            "agent.framework.name": "eve",
            "agent.framework.version": input.frameworkVersion,
            "agent.root.session.id": state.rootSessionId,
            "agent.session.id": state.sessionId,
            "agent.step.attempt": state.attemptIndex,
            "agent.step.index": state.stepIndex,
            "agent.turn.id": state.turnId,
            ...vercelSessionIdAttribute(emitVercelSessionId, state.rootSessionId),
          },
          startTime: state.startTimeMs,
        },
        contextFromActionState(state),
      ),
    );
    if (state.inputAttribute !== undefined) {
      span.setAttribute("gen_ai.tool.call.arguments", state.inputAttribute);
    }
    return span;
  };

  return {
    async contextFor(sessionId, turnId, callId) {
      const directKey = actionIdempotencyKey(sessionId, turnId, callId);
      const direct = await input.stateStore.getAction(directKey);
      if (direct !== undefined) return actionContext(direct);
      const state = await input.stateStore.findAction(sessionId, callId);
      return state === undefined ? undefined : actionContext(state);
    },
    deleteForSession: (sessionId) => input.stateStore.deleteActions(sessionId),
    deleteForTurn: (sessionId, turnId) => input.stateStore.deleteActions(sessionId, turnId),
    async failForAttempt(scope, error) {
      const keys = byAttempt.get(scope.attemptId);
      if (keys === undefined) return;
      byAttempt.delete(scope.attemptId);
      for (const key of keys) {
        const state = await input.stateStore.getAction(key);
        if (state === undefined) continue;
        const span = startSpan(state);
        recordError(span, error);
        span.end();
        await input.stateStore.deleteAction(key);
      }
    },
    events: {
      "action.completed": onTerminal,
      "action.failed": onTerminal,
      "action.started": onStarted,
    },
  };

  function forget(idempotencyKey: string): void {
    for (const [attemptId, keys] of byAttempt) {
      keys.delete(idempotencyKey);
      if (keys.size === 0) byAttempt.delete(attemptId);
    }
  }
}

function actionContext(state: AgentActionTraceState): AgentActionContext {
  const spanContext = {
    isRemote: false,
    spanId: state.spanId,
    traceFlags: state.parent.traceFlags,
    traceId: state.parent.traceId,
  };
  return {
    context: trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext)),
    spanContext,
  };
}

function contextFromActionState(state: AgentActionTraceState): Context {
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext({ ...state.parent, isRemote: false }));
}

function recordError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  } else span.setStatus({ code: SpanStatusCode.ERROR });
}
