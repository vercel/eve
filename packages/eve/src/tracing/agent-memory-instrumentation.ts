import {
  ROOT_CONTEXT,
  SpanKind,
  context,
  trace,
  type Context,
  type Span,
  type Tracer,
} from "#compiled/@opentelemetry/api/index.js";

import { contextStorage } from "#context/container.js";
import { SessionTraceSeedKey } from "#context/keys.js";
import type { InstrumentationProviderDefinition } from "#instrumentation/lifecycle.js";
import type {
  InstrumentationMemoryExecutionOperation,
  InstrumentationMemoryOperationEvent,
  InstrumentationMemoryOperationStartedEvent,
  InstrumentationMemoryOperationTerminalEvent,
} from "#instrumentation/memory.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import {
  applyLiveDeliveryAudienceCeiling,
  resolveForwardedTraceSeed,
} from "#shared/forwarded-trace-policy.js";
import { genAiMemoryRecordsAttribute } from "#tracing/agent-otel-content.js";
import { agentTraceIdentityAttributes } from "#tracing/agent-otel-attributes.js";
import { isAgentTraceContext, markAgentTraceContext } from "#tracing/agent-trace-context.js";
import { recordAgentSpanError } from "#tracing/agent-span-error.js";
import { agentSpanNamingAttributes } from "#tracing/agent-span-naming.js";
import type { AgentTraceStateStore } from "#tracing/agent-trace-state.js";
import { withChannelAudience } from "#tracing/channel-audience-context.js";
import { withErrorContent } from "#tracing/error-content-context.js";
import { isSampledTrace } from "#tracing/sampled-trace.js";
import { suppressTracing } from "#tracing/suppress-tracing.js";

type SpanState = { readonly context: Context; readonly span: Span };

export interface AgentMemoryInstrumentation {
  readonly events: Pick<
    NonNullable<InstrumentationProviderDefinition["events"]>,
    "memory.operation.completed" | "memory.operation.failed" | "memory.operation.started"
  >;
  runInContext<T>(
    operation: InstrumentationMemoryExecutionOperation,
    execute: () => PromiseLike<T>,
  ): Promise<T>;
}

export function createAgentMemoryInstrumentation(input: {
  readonly recordOutputs: boolean;
  readonly stateStore: AgentTraceStateStore;
  readonly tracer: Tracer;
}): AgentMemoryInstrumentation {
  const spans = new Map<string, SpanState>();

  const parentContext = async (
    event: InstrumentationMemoryOperationEvent,
  ): Promise<Context | undefined> => {
    const active = context.active();
    if (isAgentTraceContext(active)) return active;

    const session = await input.stateStore.getSession(event.sessionId);
    if (event.turnId !== undefined) {
      const turn = await input.stateStore.getTurn(event.sessionId, event.turnId);
      if (turn !== undefined) {
        return withChannelAudience(contextFromSpanContext(turn.context), session?.channelAudience);
      }
    }
    return session === undefined
      ? undefined
      : withChannelAudience(contextFromSpanContext(session.context), session.channelAudience);
  };

  const onStarted = async (event: InstrumentationMemoryOperationStartedEvent): Promise<void> => {
    if (spans.has(event.idempotencyKey)) return;
    const parent = await parentContext(event);
    const parentSpan = parent === undefined ? undefined : trace.getSpan(parent)?.spanContext();
    if (parent === undefined || parentSpan === undefined || !isSampledTrace(parentSpan)) return;
    const span = input.tracer.startSpan(
      event.operationName,
      {
        attributes: memorySpanAttributes(event),
        kind: SpanKind.CLIENT,
      },
      parent,
    );
    spans.set(event.idempotencyKey, {
      context: trace.setSpan(parent, span),
      span,
    });
  };

  const onTerminal = (event: InstrumentationMemoryOperationTerminalEvent): void => {
    const state = spans.get(event.idempotencyKey);
    if (state === undefined) return;
    spans.delete(event.idempotencyKey);
    updateMemorySpan(state.span, event);
    state.span.end();
  };

  return {
    events: {
      "memory.operation.completed": onTerminal,
      "memory.operation.failed": onTerminal,
      "memory.operation.started": onStarted,
    },
    async runInContext(operation, execute) {
      const session = await input.stateStore.getSession(operation.sessionId);
      let parent = spans.get(operation.idempotencyKey)?.context;
      if (parent === undefined && operation.turnId !== undefined) {
        const turn = await input.stateStore.getTurn(operation.sessionId, operation.turnId);
        if (turn !== undefined) {
          parent = withChannelAudience(
            contextFromSpanContext(turn.context),
            session?.channelAudience,
          );
          if (!isSampledTrace(turn.context)) parent = suppressTracing(parent);
        }
      }
      if (parent === undefined && session !== undefined) {
        parent = withChannelAudience(
          contextFromSpanContext(session.context),
          session.channelAudience,
        );
        if (!isSampledTrace(session.context)) parent = suppressTracing(parent);
      }
      const seed = resolveForwardedTraceSeed(contextStorage.getStore()?.get(SessionTraceSeedKey));
      const decision = seed?.decision ?? session?.decision;
      const effective =
        decision === undefined
          ? undefined
          : applyLiveDeliveryAudienceCeiling(
              decision,
              normalizeChannelAudience(session?.channelAudience),
              seed?.forwardedTracePolicy,
            );
      return parent === undefined
        ? await execute()
        : await context.with(
            markAgentTraceContext(
              withErrorContent(
                parent,
                input.recordOutputs && effective?.action === "record" && effective.recordOutputs,
              ),
            ),
            execute,
          );
    },
  };
}

function memorySpanAttributes(
  event: InstrumentationMemoryOperationEvent,
): Record<string, string | number> {
  const attributes: Record<string, string | number> = {
    "agent.memory.phase": event.phase,
    "agent.memory.slot": event.slot,
    "gen_ai.memory.store.id": event.storeId,
    "gen_ai.operation.name": event.operationName,
    ...agentSpanNamingAttributes(event.operationName, event.operationName),
    ...agentTraceIdentityAttributes({
      rootSessionId: event.rootSessionId,
      sessionId: event.sessionId,
    }),
  };
  if (event.turnId !== undefined) attributes["agent.turn.id"] = event.turnId;
  return attributes;
}

function updateMemorySpan(span: Span, event: InstrumentationMemoryOperationTerminalEvent): void {
  if (event.type === "memory.operation.failed") {
    recordAgentSpanError(span, event.error);
  } else {
    if (event.recordCount !== undefined) {
      span.setAttribute("gen_ai.memory.record.count", event.recordCount);
    }
    const records = genAiMemoryRecordsAttribute(event.outputRecords ?? []);
    if (records !== undefined && event.outputRecords !== undefined) {
      span.setAttribute("gen_ai.memory.records", records);
    }
  }
}

function contextFromSpanContext(spanContext: Parameters<typeof trace.wrapSpanContext>[0]): Context {
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext));
}
