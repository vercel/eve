import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Context,
  type Span,
  type SpanContext,
  type Tracer,
  trace,
} from "#compiled/@opentelemetry/api/index.js";

import type {
  InstrumentationActionStartedEvent,
  InstrumentationToolCallStartedEvent,
  InstrumentationToolCallTerminalEvent,
} from "#instrumentation/lifecycle.js";
import { actionIdempotencyKey } from "#instrumentation/lifecycle.js";
import { contentAttribute } from "#tracing/agent-otel-content.js";
import { withChannelAudience } from "#tracing/channel-audience-context.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { AgentActionContext } from "#tracing/agent-action-instrumentation.js";

interface ToolSpanState {
  readonly actionKey: string;
  readonly attemptId: string;
  context: Context;
  readonly event: InstrumentationToolCallStartedEvent;
  readonly fallbackParent: Context;
  readonly idempotencyKey: string;
  readonly spanId: string;
  readonly startTimeMs: number;
  contextConsumed?: true;
  finished?: true;
  suppressed?: true;
  span?: Span;
  terminal?: InstrumentationToolCallTerminalEvent;
}

export interface AgentToolInstrumentation {
  actionStarted(event: InstrumentationActionStartedEvent): Promise<void>;
  contextFor(attemptId: string, idempotencyKey: string): Context | undefined;
  drain(attemptId: string, failure?: { readonly error: unknown }): void;
  readonly events: {
    readonly "tool.call.completed": (event: InstrumentationToolCallTerminalEvent) => Promise<void>;
    readonly "tool.call.failed": (event: InstrumentationToolCallTerminalEvent) => Promise<void>;
    readonly "tool.call.started": (event: InstrumentationToolCallStartedEvent) => Promise<void>;
  };
}

/** Keeps SDK tool spans parented to actions even when SDK telemetry wins the event race. */
export function createAgentToolInstrumentation(input: {
  readonly actionContextFor: (
    sessionId: string,
    turnId: string,
    callId: string,
  ) => Promise<AgentActionContext | undefined>;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly resolveFallback: (
    event: InstrumentationToolCallStartedEvent,
  ) => { readonly context: Context; readonly spanContext: SpanContext } | undefined;
  readonly tracer: Tracer;
}): AgentToolInstrumentation {
  const byAction = new Map<string, ToolSpanState>();
  const byAttempt = new Map<string, Map<string, ToolSpanState>>();

  const onStarted = async (event: InstrumentationToolCallStartedEvent): Promise<void> => {
    const actionKey = actionIdempotencyKey(event.scope.sessionId, event.scope.turnId, event.callId);
    const fallback = input.resolveFallback(event);
    let state = fallback === undefined ? undefined : reserve(event, actionKey, fallback);
    const actionParent = await input.actionContextFor(
      event.scope.sessionId,
      event.scope.turnId,
      event.callId,
    );
    if (state === undefined) {
      if (actionParent === undefined) return;
      state = reserve(event, actionKey, actionParent);
    }
    if (actionParent !== undefined && isAgentInvocation(actionParent)) {
      suppress(state, actionParent);
      return;
    }
    if (actionParent !== undefined) startSpan(state, actionParent.context);
  };

  const onTerminal = async (event: InstrumentationToolCallTerminalEvent): Promise<void> => {
    const state = byAttempt.get(event.scope.attemptId)?.get(event.idempotencyKey);
    if (state === undefined) return;
    state.terminal = event;

    if (state.span === undefined && state.suppressed !== true) {
      const actionParent = await input.actionContextFor(
        state.event.scope.sessionId,
        state.event.scope.turnId,
        state.event.callId,
      );
      if (actionParent !== undefined && isAgentInvocation(actionParent)) {
        suppress(state, actionParent);
      } else if (actionParent !== undefined) {
        startSpan(state, actionParent.context);
      }
    }
    finishIfReady(state);
  };

  return {
    async actionStarted(event) {
      const state = byAction.get(event.idempotencyKey);
      if (state === undefined || state.span !== undefined || state.finished === true) return;
      const actionParent = await input.actionContextFor(
        event.scope.sessionId,
        event.scope.turnId,
        event.callId,
      );
      if (actionParent === undefined) return;
      if (isAgentInvocation(actionParent)) suppress(state, actionParent);
      else startSpan(state, actionParent.context);
      finishIfReady(state);
    },
    contextFor(attemptId, idempotencyKey) {
      const state = byAttempt.get(attemptId)?.get(idempotencyKey);
      if (state !== undefined) state.contextConsumed = true;
      return state?.context;
    },
    drain(attemptId, failure) {
      const states = byAttempt.get(attemptId);
      if (states === undefined) return;
      for (const state of states.values()) {
        if (state.finished === true) continue;
        if (state.suppressed === true) {
          finish(state);
          continue;
        }
        if (state.span === undefined) startSpan(state, state.fallbackParent);
        finish(state, failure);
      }
      byAttempt.delete(attemptId);
    },
    events: {
      "tool.call.completed": onTerminal,
      "tool.call.failed": onTerminal,
      "tool.call.started": onStarted,
    },
  };

  function getAttemptStates(attemptId: string): Map<string, ToolSpanState> {
    let states = byAttempt.get(attemptId);
    if (states === undefined) {
      states = new Map();
      byAttempt.set(attemptId, states);
    }
    return states;
  }

  function reserve(
    event: InstrumentationToolCallStartedEvent,
    actionKey: string,
    parent: { readonly context: Context; readonly spanContext: SpanContext },
  ): ToolSpanState {
    const spanId = input.idGenerator.deriveSpanId(`tool:${event.idempotencyKey}`);
    const state: ToolSpanState = {
      actionKey,
      attemptId: event.scope.attemptId,
      context: withChannelAudience(
        contextFromSpanContext({
          isRemote: false,
          spanId,
          traceFlags: parent.spanContext.traceFlags,
          traceId: parent.spanContext.traceId,
        }),
        event.scope.channelAudience,
      ),
      event,
      fallbackParent: parent.context,
      idempotencyKey: event.idempotencyKey,
      spanId,
      startTimeMs: Date.now(),
    };
    getAttemptStates(event.scope.attemptId).set(event.idempotencyKey, state);
    byAction.set(actionKey, state);
    return state;
  }

  function startSpan(state: ToolSpanState, parent: Context): void {
    if (state.span !== undefined || state.finished === true || state.suppressed === true) {
      return;
    }
    state.span = input.idGenerator.withSpanId(state.spanId, () =>
      input.tracer.startSpan(
        `execute_tool ${state.event.toolName}`,
        {
          attributes: toolAttributes(state.event),
          kind: SpanKind.INTERNAL,
          startTime: state.startTimeMs,
        },
        parent,
      ),
    );
    if (input.recordInputs) {
      const args = contentAttribute(state.event.input, false);
      if (args !== undefined) state.span.setAttribute("gen_ai.tool.call.arguments", args);
    }
  }

  function finishIfReady(state: ToolSpanState): void {
    if ((state.span === undefined && state.suppressed !== true) || state.terminal === undefined) {
      return;
    }
    finish(state);
  }

  function finish(state: ToolSpanState, failure?: { readonly error: unknown }): void {
    const span = state.span;
    if ((span === undefined && state.suppressed !== true) || state.finished === true) {
      return;
    }
    state.finished = true;
    const terminal = state.terminal;
    if (span === undefined) {
      cleanup(state);
      return;
    }
    if (failure !== undefined) {
      recordError(span, failure.error);
    } else if (terminal?.type === "tool.call.failed") {
      recordError(span, terminal.error);
    } else if (terminal?.output.type === "error") {
      recordError(span, terminal.output.error);
    } else if (terminal !== undefined && input.recordOutputs) {
      const result = contentAttribute(terminal.output.output, false);
      if (result !== undefined) span.setAttribute("gen_ai.tool.call.result", result);
    }
    span.end();
    cleanup(state);
  }

  function suppress(state: ToolSpanState, action: AgentActionContext): void {
    if (state.contextConsumed === true || state.span !== undefined) {
      state.suppressed = undefined;
      startSpan(state, action.context);
      return;
    }
    state.context = action.context;
    state.suppressed = true;
  }

  function cleanup(state: ToolSpanState): void {
    byAction.delete(state.actionKey);
    const states = byAttempt.get(state.attemptId);
    states?.delete(state.idempotencyKey);
    if (states?.size === 0) byAttempt.delete(state.attemptId);
  }
}

function isAgentInvocation(action: AgentActionContext): boolean {
  return action.kind === "subagent-call" || action.kind === "remote-agent-call";
}

function toolAttributes(event: InstrumentationToolCallStartedEvent): Record<string, string> {
  return {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.call.id": event.callId,
    "gen_ai.tool.name": event.toolName,
    "gen_ai.tool.type": "function",
  };
}

function contextFromSpanContext(spanContext: SpanContext): Context {
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext));
}

function recordError(span: Span, error: unknown): void {
  span.setAttribute("error.type", error instanceof Error ? error.name || "Error" : "_OTHER");
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  } else span.setStatus({ code: SpanStatusCode.ERROR });
}
