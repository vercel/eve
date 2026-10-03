import { ROOT_CONTEXT, type Context, type SpanContext, trace } from "@opentelemetry/api";

import type {
  InstrumentationActionStartedEvent,
  InstrumentationActionTerminalEvent,
  InstrumentationAttemptScope,
  InstrumentationProviderDefinition,
} from "#instrumentation/lifecycle.js";
import { actionIdempotencyKey } from "#instrumentation/lifecycle.js";
import type {
  AgentActionTraceState,
  AgentTraceStateStore,
} from "#tracing/eve/agent-trace-state.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import { isSampledTrace } from "#shared/trace-policy.js";
import { withChannelAudience } from "#tracing/eve/channel-audience-context.js";
import { eveOperationInput } from "#tracing/eve/operation-input.js";
import {
  snapshotReference,
  type Operation as ActionOperation,
  type DurableTraceRuntime,
} from "#tracing/lib/index.js";

interface AgentActionInstrumentation {
  readonly events: Pick<
    NonNullable<InstrumentationProviderDefinition["events"]>,
    "action.completed" | "action.failed" | "action.started"
  >;
  deleteForSession(sessionId: string): void | PromiseLike<void>;
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
  readonly lifecycle: DurableTraceRuntime;
  readonly frameworkVersion: string;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly resolveTraceContext: (
    event: InstrumentationActionStartedEvent,
  ) => SpanContext | undefined | PromiseLike<SpanContext | undefined>;
  readonly stateStore: AgentTraceStateStore;
}): AgentActionInstrumentation {
  const onStarted = async (event: InstrumentationActionStartedEvent): Promise<void> => {
    const traceContext = await input.resolveTraceContext(event);
    if (traceContext === undefined || !isSampledTrace(traceContext)) return;

    const existing = await input.stateStore.get("action", event.idempotencyKey);
    let state = existing;
    if (state === undefined) {
      const operation = await input.lifecycle.action({
        parentAttemptId: event.scope.attemptId,
        ...eveOperationInput(
          { ...event.scope, frameworkVersion: input.frameworkVersion, parent: traceContext },
          event.idempotencyKey,
        ),
        action: {
          callId: event.callId,
          kind: event.kind,
          name: event.name,
          arguments: input.recordInputs ? event.input : undefined,
        },
      });
      if (operation === undefined || operation.parent === undefined) return;
      state = {
        snapshot: operation.snapshot(),
        attemptId: event.scope.attemptId,
        callId: event.callId,
        channelAudience: normalizeChannelAudience(event.scope.channelAudience),
        sessionId: event.scope.sessionId,
        turnId: event.scope.turnId,
      };
      await input.stateStore.set("action", event.idempotencyKey, state);
    }
    if (event.isWorkflowTool === true) {
      await input.stateStore.set("anchor", event.idempotencyKey, state);
    }
  };

  const onTerminal = async (event: InstrumentationActionTerminalEvent): Promise<void> => {
    const state = await input.stateStore.get("action", event.idempotencyKey);
    if (state === undefined) return;
    try {
      await finishActionSpan(state, event);
    } finally {
      await input.stateStore.delete("action", event.idempotencyKey);
    }
  };

  const startScope = async (state: AgentActionTraceState): Promise<ActionOperation | undefined> => {
    const operation = await input.lifecycle.resume(state.snapshot, {
      context: withChannelAudience(ROOT_CONTEXT, state.channelAudience),
    });
    return operation?.type === "action" ? operation : undefined;
  };

  return {
    async contextFor(sessionId, turnId, callId) {
      const directKey = actionIdempotencyKey(sessionId, turnId, callId);
      const direct = await input.stateStore.get("action", directKey);
      if (direct !== undefined) return actionContext(direct);
      const state = (await input.stateStore.entries("action")).find(
        ([, state]) => state.sessionId === sessionId && state.callId === callId,
      )?.[1];
      return state === undefined ? undefined : actionContext(state);
    },
    async deleteForSession(sessionId) {
      for (const kind of ["action", "anchor"] as const)
        for (const [key, state] of await input.stateStore.entries(kind))
          if (state.sessionId === sessionId) await input.stateStore.delete(kind, key);
    },
    async failForAttempt(scope, error) {
      for (const [key, state] of await input.stateStore.entries("action")) {
        if (state.attemptId !== scope.attemptId) continue;
        const operation = await startScope(state);
        await operation?.fail(error);
        await input.stateStore.delete("action", key);
      }
    },
    events: {
      "action.completed": onTerminal,
      "action.failed": onTerminal,
      "action.started": onStarted,
    },
  };

  async function finishActionSpan(
    state: AgentActionTraceState,
    event: InstrumentationActionTerminalEvent,
  ): Promise<void> {
    const scope = await startScope(state);
    const error =
      event.type === "action.failed"
        ? event.error
        : event.output.type === "error"
          ? event.output.error
          : undefined;
    await scope?.complete({
      outcome:
        event.type === "action.failed" || event.output.type === "error" ? "failed" : "completed",
      errorType: event.type === "action.failed" ? (event.errorCode ?? "Error") : "Error",
      error,
      output:
        input.recordOutputs && event.type === "action.completed" && event.output.type === "result"
          ? event.output.output
          : undefined,
      usage: event.usage,
      endTimeMs: event.acceptedAtMs,
    });
  }
}

function actionContext(state: AgentActionTraceState): AgentActionContext | undefined {
  const spanContext = snapshotReference(state.snapshot);
  if (spanContext === undefined) return undefined;
  return {
    context: withChannelAudience(
      trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext)),
      state.channelAudience,
    ),
    spanContext,
  };
}
