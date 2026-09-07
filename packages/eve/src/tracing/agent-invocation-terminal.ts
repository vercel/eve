import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import type { AgentActionTraceTerminalState } from "#tracing/agent-trace-state.js";
import {
  AGENT_TRACE_CONTEXT_KEY,
  deserializeAgentTraceContextState,
  serializeAgentTraceContextState,
} from "#tracing/agent-trace-context-codec.js";

/** Pure context updates also run during workflow replay; no step I/O is needed. */
export function recordNestedAgentInvocationTerminal(input: {
  readonly callId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly terminal: AgentActionTraceTerminalState;
  readonly turnId?: string;
}): Record<string, unknown> {
  const raw = input.serializedContext[AGENT_TRACE_CONTEXT_KEY];
  if (raw === undefined) return input.serializedContext;
  const state = deserializeAgentTraceContextState(raw);
  const entry = Object.entries(state.invocations).find(
    ([, invocation]) =>
      invocation.sessionId === input.sessionId &&
      (input.turnId === undefined || invocation.turnId === input.turnId) &&
      invocation.callId === input.callId,
  );
  if (entry === undefined) return input.serializedContext;
  const [key, invocation] = entry;
  if (invocation.terminal !== undefined) return input.serializedContext;
  return {
    ...input.serializedContext,
    [AGENT_TRACE_CONTEXT_KEY]: serializeAgentTraceContextState({
      ...state,
      invocations: {
        ...state.invocations,
        [key]: { ...invocation, terminal: input.terminal },
      },
    }),
  };
}

export function settleAgentInvocationTrace(input: {
  readonly result: RuntimeSubagentChildResult;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
}): Record<string, unknown> {
  const turnResult = input.result.outcome.result;
  const usage = input.result.usage ?? input.result.outcome.usageDelta;
  return recordNestedAgentInvocationTerminal({
    callId: input.result.callId,
    serializedContext: input.serializedContext,
    sessionId: input.sessionId,
    terminal: {
      acceptedAtMs: Date.now(),
      error: turnResult.kind === "failed" ? invocationError(turnResult.error) : undefined,
      outcome:
        turnResult.kind === "succeeded"
          ? "completed"
          : turnResult.kind === "cancelled"
            ? "cancelled"
            : "failed",
      usage: {
        inputTokenDetails: {
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        },
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    },
  });
}

export function invocationError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "object" && value !== null && "message" in value) {
    return new Error(String(value.message));
  }
  return new Error(typeof value === "string" ? value : "Agent invocation failed.");
}
