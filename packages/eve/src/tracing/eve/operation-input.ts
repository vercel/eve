import { resolveConversationId } from "#shared/conversation-identity.js";
import type { AgentTraceStateStore } from "#tracing/eve/agent-trace-state.js";
import {
  createAgentRun,
  type AgentTelemetry,
  type AgentRun,
  type TraceCheckpointer,
} from "#compiled/@vercel/agent-runs/index.js";

export function checkpointContent(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

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

export function createEveTracing(input: {
  readonly telemetry: AgentTelemetry;
  readonly stateStore: AgentTraceStateStore;
}): AgentRun {
  const checkpointer: TraceCheckpointer = {
    get: (key) => input.stateStore.get("checkpoint", key),
    set: (key, value) => input.stateStore.set("checkpoint", key, value),
    delete: (key) => input.stateStore.delete("checkpoint", key),
  };
  return createAgentRun({ telemetry: input.telemetry, checkpointer });
}
