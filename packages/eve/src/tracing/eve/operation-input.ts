import type { SpanContext } from "@opentelemetry/api";

import { resolveConversationId } from "#shared/conversation-identity.js";
import type { AgentTraceStateStore } from "#tracing/eve/agent-trace-state.js";
import {
  createAgentTracing,
  type AgentTelemetry,
  type AgentTracing,
  type TraceCheckpointer,
} from "#tracing/lib/index.js";

export function traceSessionIdOf(scope: {
  readonly traceSessionId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
}): string {
  return scope.traceSessionId ?? scope.rootSessionId ?? scope.sessionId;
}

export function checkpointContent(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  // Historical checkpoints contain truncated JSON; omit payloads, not the operation.
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Identity of one eve turn within the shared tracing library. */
export function eveTurnIdentity(input: {
  readonly sessionId: string;
  readonly rootSessionId?: string;
  readonly turnId: string;
}) {
  return {
    conversationId: resolveConversationId(input.rootSessionId ?? input.sessionId),
    runId: input.sessionId,
    turnId: input.turnId,
  };
}

/** Content flags are recorded by eve's content processor, not withheld by the library. */
export function eveCapture(reference: SpanContext | undefined) {
  return {
    emit: ((reference?.traceFlags ?? 1) & 1) !== 0,
    recordInputs: true,
    recordOutputs: true,
  };
}

/** eve's agent tracing, checkpointed in its workflow-context trace state. */
export function createEveTracing(input: {
  readonly telemetry: AgentTelemetry;
  readonly stateStore: AgentTraceStateStore;
}): AgentTracing {
  const checkpointer: TraceCheckpointer = {
    get: (key) => input.stateStore.get("checkpoint", key),
    set: (key, value) => input.stateStore.set("checkpoint", key, value),
    delete: (key) => input.stateStore.delete("checkpoint", key),
  };
  return createAgentTracing({ telemetry: input.telemetry, checkpointer });
}
