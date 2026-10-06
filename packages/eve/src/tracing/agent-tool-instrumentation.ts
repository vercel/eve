import {
  ROOT_CONTEXT,
  SpanKind,
  type Context,
  type Attributes,
  type Span,
  type SpanContext,
  type Tracer,
  trace,
} from "#compiled/@opentelemetry/api/index.js";

import type {
  InstrumentationAttemptScope,
  InstrumentationToolCallStartedEvent,
  InstrumentationToolCallTerminalEvent,
} from "#instrumentation/lifecycle.js";
import { actionIdempotencyKey, attemptIdempotencyKey } from "#instrumentation/lifecycle.js";
import { contentAttribute, textContentAttribute } from "#tracing/agent-otel-content.js";
import { agentSpanNamingAttributes } from "#tracing/agent-span-naming.js";
import { agentTraceIdentityAttributes, traceSessionIdOf } from "#tracing/agent-otel-attributes.js";
import { withChannelAudience } from "#tracing/channel-audience-context.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { AgentActionTraceState, AgentTraceStateStore } from "#tracing/agent-trace-state.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import { isSampledTrace } from "#tracing/sampled-trace.js";
import { setAgentUsage } from "#tracing/agent-otel-usage.js";
import { recordAgentSpanError as recordError } from "#tracing/agent-span-error.js";
import { withAgentToolSpanContext } from "#tracing/agent-tool-span-context.js";

interface ToolSpanState {
  readonly actionKey: string;
  readonly attemptId: string;
  context: Context;
  readonly additionalAttributes: Attributes;
  readonly event: InstrumentationToolCallStartedEvent;
  readonly fallbackParent: Context;
  readonly idempotencyKey: string;
  readonly spanId: string;
  readonly startTimeMs: number;
  finished?: true;
  span?: Span;
  terminal?: InstrumentationToolCallTerminalEvent;
  pendingError?: { readonly error: unknown; readonly errorType?: string };
  correlated?: true;
}

export interface AgentToolContext {
  readonly context: Context;
  readonly spanContext: SpanContext;
}

interface AgentToolInstrumentation {
  deleteForSession(sessionId: string): Promise<void>;
  failForAttempt(scope: InstrumentationAttemptScope, error: unknown): Promise<void>;
  dispatchContextFor(
    sessionId: string,
    turnId: string,
    callId: string,
  ): Promise<AgentToolContext | undefined>;
  contextFor(attemptId: string, idempotencyKey: string): Context | undefined;
  drain(attemptId: string, failure?: { readonly error: unknown }): void;
  readonly events: {
    readonly "tool.call.completed": (event: InstrumentationToolCallTerminalEvent) => Promise<void>;
    readonly "tool.call.failed": (event: InstrumentationToolCallTerminalEvent) => Promise<void>;
    readonly "tool.call.started": (event: InstrumentationToolCallStartedEvent) => Promise<void>;
  };
  readonly execution: {
    readonly started: (event: InstrumentationToolCallStartedEvent) => Promise<void>;
    readonly completed: (event: InstrumentationToolCallTerminalEvent) => Promise<void>;
    readonly failed: (event: InstrumentationToolCallTerminalEvent) => Promise<void>;
  };
}

/** Enriches durable tool calls, exporting SDK-only calls under their step. */
export function createAgentToolInstrumentation(input: {
  readonly frameworkVersion: string;
  readonly resolveTraceContext: (
    event: InstrumentationToolCallStartedEvent,
  ) => SpanContext | undefined | PromiseLike<SpanContext | undefined>;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly resolveFallback: (
    event: InstrumentationToolCallStartedEvent,
  ) => { readonly context: Context; readonly spanContext: SpanContext } | undefined;
  readonly tracer: Tracer;
  readonly stateStore: AgentTraceStateStore;
}): AgentToolInstrumentation {
  const byAction = new Map<string, ToolSpanState>();
  const byAttempt = new Map<string, Map<string, ToolSpanState>>();
  const dispatchesByAttempt = new Map<string, Set<string>>();

  async function dispatchContextFor(
    sessionId: string,
    turnId: string,
    callId: string,
  ): Promise<AgentToolContext | undefined> {
    const state =
      (await input.stateStore.getAction(actionIdempotencyKey(sessionId, turnId, callId))) ??
      (await input.stateStore.findAction(sessionId, callId));
    if (state === undefined) return undefined;
    const spanContext = {
      isRemote: false,
      spanId: state.spanId,
      traceFlags: state.parent.traceFlags,
      traceId: state.parent.traceId,
    };
    return {
      context: withChannelAudience(contextFromSpanContext(spanContext), state.channelAudience),
      spanContext,
    };
  }

  async function onDispatchStarted(event: InstrumentationToolCallStartedEvent): Promise<void> {
    const traceContext = await input.resolveTraceContext(event);
    if (traceContext === undefined || !isSampledTrace(traceContext)) return;
    const existing = await input.stateStore.getAction(event.idempotencyKey);
    const state: AgentActionTraceState = existing ?? {
      attemptIndex: event.scope.attemptIndex,
      callId: event.callId,
      channelAudience: normalizeChannelAudience(event.scope.channelAudience),
      inputAttribute: input.recordInputs ? contentAttribute(event.input) : undefined,
      kind: event.kind ?? "tool-call",
      name: event.toolName,
      parent: {
        spanId: input.idGenerator.deriveSpanId(
          event.parentCallId === undefined
            ? attemptIdempotencyKey(event.scope)
            : `action:${actionIdempotencyKey(event.scope.sessionId, event.scope.turnId, event.parentCallId)}`,
        ),
        traceFlags: traceContext.traceFlags,
        traceId: traceContext.traceId,
      },
      parentCallId: event.parentCallId,
      rootSessionId: event.scope.rootSessionId ?? event.scope.sessionId,
      traceSessionId: traceSessionIdOf(event.scope),
      sessionId: event.scope.sessionId,
      spanId: input.idGenerator.deriveSpanId(`action:${event.idempotencyKey}`),
      startTimeMs: Math.min(
        event.startedAtMs ?? Date.now(),
        byAction.get(event.idempotencyKey)?.startTimeMs ?? Infinity,
      ),
      stepIndex: event.scope.stepIndex,
      turnId: event.scope.turnId,
    };
    await input.stateStore.setAction(event.idempotencyKey, state);
    if (event.isWorkflowTool === true)
      await input.stateStore.setActionAnchor(event.idempotencyKey, state);
    const keys = dispatchesByAttempt.get(event.scope.attemptId) ?? new Set<string>();
    keys.add(event.idempotencyKey);
    dispatchesByAttempt.set(event.scope.attemptId, keys);
    const execution = byAction.get(event.idempotencyKey);
    if (execution !== undefined && execution.finished !== true) {
      await correlate(execution);
      finishIfReady(execution);
    }
  }

  async function onDispatchTerminal(event: InstrumentationToolCallTerminalEvent): Promise<void> {
    const state = await input.stateStore.getAction(event.idempotencyKey);
    if (state === undefined) return;
    try {
      const span = startDispatchSpan(state);
      const outcome = event.outcome ?? (event.type === "tool.call.failed" ? "failed" : "completed");
      span.setAttribute(
        "agent.action.outcome",
        state.toolFailed === true && outcome === "completed" ? "failed" : outcome,
      );
      if (event.usage !== undefined) setAgentUsage(span, event.usage);
      if (event.type === "tool.call.failed") {
        if (event.errorCode !== undefined)
          span.setAttribute("agent.action.error.code", event.errorCode);
        recordToolError(span, event.error, event.errorCode);
      } else if (event.output.type === "error") {
        recordToolError(span, event.output.error);
      } else if (state.toolFailed === true) {
        recordToolError(
          span,
          state.toolErrorAttribute,
          typeof state.toolAttributes?.["error.type"] === "string"
            ? state.toolAttributes["error.type"]
            : undefined,
        );
      } else if (input.recordOutputs) {
        const result = contentAttribute(event.output.output);
        if (result !== undefined) span.setAttribute("gen_ai.tool.call.result", result);
      }
      span.end(event.acceptedAtMs ?? state.toolEndTimeMs);
    } finally {
      await input.stateStore.deleteAction(event.idempotencyKey);
      for (const [attemptId, keys] of dispatchesByAttempt) {
        keys.delete(event.idempotencyKey);
        if (keys.size === 0) dispatchesByAttempt.delete(attemptId);
      }
    }
  }

  function startDispatchSpan(state: AgentActionTraceState): Span {
    const invocation = state.kind === "subagent-call" || state.kind === "remote-agent-call";
    const span = input.idGenerator.withSpanId(state.spanId, () =>
      input.tracer.startSpan(
        `execute_tool ${state.name}`,
        {
          attributes: {
            "agent.action.call_id": state.callId,
            "agent.action.kind": state.kind,
            "agent.action.name": state.name,
            ...(state.parentCallId === undefined
              ? undefined
              : { "agent.action.parent_call_id": state.parentCallId }),
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.call.id": state.callId,
            "gen_ai.tool.name": state.name,
            "gen_ai.tool.type": "function",
            "agent.framework.name": "eve",
            "agent.framework.version": input.frameworkVersion,
            "agent.step.attempt": state.attemptIndex,
            "agent.step.index": state.stepIndex,
            "agent.turn.id": state.turnId,
            ...agentSpanNamingAttributes(`execute_tool ${state.name}`, "execute_tool"),
            ...agentTraceIdentityAttributes({
              rootSessionId: state.rootSessionId,
              traceSessionId: state.traceSessionId,
              sessionId: state.sessionId,
            }),
            ...(invocation
              ? { "gen_ai.agent.name": state.name, "agent.invocation.role": "caller" }
              : undefined),
            ...state.toolAttributes,
          },
          kind: state.kind === "remote-agent-call" ? SpanKind.CLIENT : SpanKind.INTERNAL,
          startTime: state.startTimeMs,
        },
        withChannelAudience(
          contextFromSpanContext({ ...state.parent, isRemote: false }),
          state.channelAudience,
        ),
      ),
    );
    if (state.inputAttribute !== undefined)
      span.setAttribute("gen_ai.tool.call.arguments", state.inputAttribute);
    return span;
  }

  const onStarted = async (event: InstrumentationToolCallStartedEvent): Promise<void> => {
    if (byAttempt.get(event.scope.attemptId)?.has(event.idempotencyKey)) return;
    const actionKey = actionIdempotencyKey(event.scope.sessionId, event.scope.turnId, event.callId);
    const fallback = input.resolveFallback(event);
    let state = fallback === undefined ? undefined : reserve(event, actionKey, fallback);
    const actionParent = await dispatchContextFor(
      event.scope.sessionId,
      event.scope.turnId,
      event.callId,
    );
    if (state === undefined) {
      if (actionParent === undefined) return;
      state = reserve(event, actionKey, actionParent);
    }
    if (actionParent !== undefined) await correlate(state);
  };

  const onTerminal = async (event: InstrumentationToolCallTerminalEvent): Promise<void> => {
    const state = byAttempt.get(event.scope.attemptId)?.get(event.idempotencyKey);
    if (state === undefined) return;
    state.terminal = event;

    if (state.span === undefined) {
      const actionParent = await dispatchContextFor(
        state.event.scope.sessionId,
        state.event.scope.turnId,
        state.event.callId,
      );
      if (actionParent !== undefined) await correlate(state);
    }
    finishIfReady(state);
  };

  return {
    dispatchContextFor,
    async deleteForSession(sessionId) {
      await input.stateStore.deleteActions(sessionId);
      await input.stateStore.deleteActionAnchors(sessionId);
    },
    async failForAttempt(scope, error) {
      const keys = dispatchesByAttempt.get(scope.attemptId);
      dispatchesByAttempt.delete(scope.attemptId);
      for (const key of keys ?? []) {
        const state = await input.stateStore.getAction(key);
        if (state === undefined) continue;
        const span = startDispatchSpan(state);
        recordError(span, error);
        span.end();
        await input.stateStore.deleteAction(key);
      }
    },
    contextFor: (attemptId, idempotencyKey) =>
      byAttempt.get(attemptId)?.get(idempotencyKey)?.context,
    drain(attemptId, failure) {
      const states = byAttempt.get(attemptId);
      if (states === undefined) return;
      for (const state of states.values()) {
        if (state.finished === true) continue;
        if (state.span === undefined && state.correlated !== true)
          startSpan(state, state.fallbackParent);
        finish(state, failure);
      }
      byAttempt.delete(attemptId);
    },
    events: {
      "tool.call.completed": onDispatchTerminal,
      "tool.call.failed": onDispatchTerminal,
      "tool.call.started": onDispatchStarted,
    },
    execution: { started: onStarted, completed: onTerminal, failed: onTerminal },
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
    const spanId = input.idGenerator.deriveSpanId(`action:${actionKey}`);
    const state: ToolSpanState = {
      actionKey,
      attemptId: event.scope.attemptId,
      additionalAttributes: {},
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
      startTimeMs: event.startedAtMs ?? Date.now(),
    };
    state.context = withAgentToolSpanContext(state.context, {
      recordInputs: input.recordInputs,
      recordOutputs: input.recordOutputs,
      setAttributes(attributes) {
        Object.assign(state.additionalAttributes, attributes);
        if (state.span === undefined) return;
        for (const [name, value] of Object.entries(attributes)) {
          if (value !== undefined) state.span.setAttribute(name, value);
        }
      },
      recordError(error, errorType) {
        state.pendingError = { error, errorType };
        if (state.span !== undefined) recordError(state.span, error, errorType);
      },
    });
    getAttemptStates(event.scope.attemptId).set(event.idempotencyKey, state);
    byAction.set(actionKey, state);
    return state;
  }

  function startSpan(state: ToolSpanState, parent: Context): void {
    if (state.span !== undefined || state.finished === true) return;
    state.span = input.idGenerator.withSpanId(state.spanId, () =>
      input.tracer.startSpan(
        `execute_tool ${state.event.toolName}`,
        {
          attributes: { ...toolAttributes(state.event), ...state.additionalAttributes },
          kind: SpanKind.INTERNAL,
          startTime: state.startTimeMs,
        },
        parent,
      ),
    );
    if (state.pendingError !== undefined) {
      recordError(state.span, state.pendingError.error, state.pendingError.errorType);
    }
    if (input.recordInputs) {
      const args = contentAttribute(state.event.input);
      if (args !== undefined) state.span.setAttribute("gen_ai.tool.call.arguments", args);
    }
  }

  function finishIfReady(state: ToolSpanState): void {
    if ((state.span === undefined && state.correlated !== true) || state.terminal === undefined)
      return;
    finish(state);
  }

  async function correlate(state: ToolSpanState): Promise<void> {
    const action =
      (await input.stateStore.getAction(state.actionKey)) ??
      (await input.stateStore.findAction(state.event.scope.sessionId, state.event.callId));
    if (action === undefined) return;
    state.correlated = true;
    state.context = trace.setSpan(
      state.context,
      trace.wrapSpanContext({
        isRemote: false,
        spanId: action.spanId,
        traceFlags: action.parent.traceFlags,
        traceId: action.parent.traceId,
      }),
    );
    const terminal = state.terminal;
    const toolFailed =
      state.pendingError !== undefined ||
      terminal?.type === "tool.call.failed" ||
      terminal?.output.type === "error";
    const error =
      state.pendingError?.error ??
      (terminal?.type === "tool.call.failed"
        ? terminal.error
        : terminal?.output.type === "error"
          ? terminal.output.error
          : undefined);
    const attributes: Attributes = {
      ...action.toolAttributes,
      ...(state.event.scope.functionId === undefined ||
      action.kind === "subagent-call" ||
      action.kind === "remote-agent-call"
        ? undefined
        : { "gen_ai.agent.name": state.event.scope.functionId }),
      "agent.tool.is_framework": state.event.frameworkTool === true,
      ...state.additionalAttributes,
      ...(state.pendingError?.errorType === undefined
        ? undefined
        : { "error.type": state.pendingError.errorType }),
      ...(terminal?.type === "tool.call.completed" && terminal.durationMs !== undefined
        ? { "gen_ai.execute_tool.duration": terminal.durationMs / 1000 }
        : undefined),
    };
    await input.stateStore.setAction(
      actionIdempotencyKey(action.sessionId, action.turnId, action.callId),
      {
        ...action,
        startTimeMs: Math.min(action.startTimeMs, state.startTimeMs),
        toolAttributes: attributes,
        toolEndTimeMs: terminal?.completedAtMs ?? action.toolEndTimeMs,
        toolFailed: toolFailed || action.toolFailed,
        toolErrorAttribute:
          input.recordOutputs && error !== undefined
            ? contentAttribute(error instanceof Error ? error.message : error)
            : action.toolErrorAttribute,
      },
    );
  }

  function finish(state: ToolSpanState, failure?: { readonly error: unknown }): void {
    const span = state.span;
    if (state.finished === true) return;
    if (state.correlated === true) {
      state.finished = true;
      forget(state);
      return;
    }
    if (span === undefined) return;
    state.finished = true;
    const terminal = state.terminal;
    // As `@ai-sdk/otel` records it: execute's own run time, in seconds, success or error.
    if (terminal?.type === "tool.call.completed" && terminal.durationMs !== undefined) {
      span.setAttribute("gen_ai.execute_tool.duration", terminal.durationMs / 1000);
    }
    if (failure !== undefined) {
      recordError(span, failure.error);
    } else if (terminal?.type === "tool.call.failed") {
      recordError(span, terminal.error);
    } else if (terminal?.output.type === "error") {
      recordError(span, terminal.output.error);
    } else if (terminal !== undefined && input.recordOutputs) {
      const result = contentAttribute(terminal.output.output);
      if (result !== undefined) span.setAttribute("gen_ai.tool.call.result", result);
    }
    span.end(terminal?.completedAtMs);
    forget(state);
  }

  function forget(state: ToolSpanState): void {
    byAction.delete(state.actionKey);
    const states = byAttempt.get(state.attemptId);
    states?.delete(state.idempotencyKey);
    if (states?.size === 0) byAttempt.delete(state.attemptId);
  }
}

function toolAttributes(event: InstrumentationToolCallStartedEvent): Attributes {
  return {
    "agent.tool.is_framework": event.frameworkTool === true,
    ...(event.scope.functionId === undefined
      ? {}
      : { "gen_ai.agent.name": event.scope.functionId }),
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.call.id": event.callId,
    "gen_ai.tool.name": event.toolName,
    "gen_ai.tool.type": "function",
    ...agentSpanNamingAttributes(`execute_tool ${event.toolName}`, "execute_tool"),
    ...agentTraceIdentityAttributes({
      rootSessionId: event.scope.rootSessionId ?? event.scope.sessionId,
      traceSessionId: traceSessionIdOf(event.scope),
      sessionId: event.scope.sessionId,
    }),
  };
}

function contextFromSpanContext(spanContext: SpanContext): Context {
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext));
}

function recordToolError(span: Span, error: unknown, errorType?: string): void {
  if (error instanceof Error || error === undefined) {
    recordError(span, error, errorType);
    return;
  }
  const serialized =
    typeof error === "string" ? textContentAttribute(error) : contentAttribute(error);
  const message =
    typeof error === "object" && error !== null && !Array.isArray(error)
      ? Reflect.get(error, "message")
      : undefined;
  const detail =
    typeof message === "string"
      ? textContentAttribute(serialized === undefined ? message : `${message}\n${serialized}`)
      : serialized;
  const normalized = detail === undefined ? undefined : new Error(detail);
  if (normalized !== undefined && errorType !== undefined) normalized.name = errorType;
  recordError(span, normalized, errorType);
}
