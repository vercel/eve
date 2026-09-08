import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import type { AgentActionTraceTerminalState } from "#tracing/agent-trace-state.js";
import {
  AGENT_TRACE_CONTEXT_KEY,
  deserializeAgentTraceContextState,
  serializeAgentTraceContextState,
} from "#tracing/agent-trace-context-codec.js";
import { truncateTelemetryText } from "#tracing/telemetry-budget.js";
import { boundedTraceError } from "#tracing/bounded-error.js";
import { contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { getInstrumentationRuntime } from "#instrumentation/runtime.js";

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
        [key]: {
          ...invocation,
          terminal: {
            ...input.terminal,
            error:
              invocation.recordOutputs === true && input.terminal.error !== undefined
                ? invocationError(input.terminal.error)
                : undefined,
          },
        },
      },
    }),
  };
}

export function settleAgentInvocationTrace(input: {
  readonly acceptedAtMs: number;
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
      acceptedAtMs: input.acceptedAtMs,
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

/** Called inside dispatch/settlement steps, so replay reuses the flushed context. */
export async function flushAgentInvocationTraces(
  serializedContext: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (serializedContext[AGENT_TRACE_CONTEXT_KEY] === undefined) return serializedContext;
  const ctx = await deserializeContext(serializedContext);
  const runtime = getInstrumentationRuntime();
  if (runtime === undefined) return serializedContext;
  await contextStorage.run(ctx, () => runtime.forceFlush());
  return {
    ...serializedContext,
    [AGENT_TRACE_CONTEXT_KEY]: serializeContext(ctx)[AGENT_TRACE_CONTEXT_KEY],
  };
}

export function invocationError(value: unknown): Error {
  if (value instanceof Error) {
    return boundedTraceError(value);
  }
  if (typeof value === "object" && value !== null && "message" in value) {
    return new Error(truncateTelemetryText(String(value.message), 4096));
  }
  return new Error(
    typeof value === "string" ? truncateTelemetryText(value, 4096) : "Agent invocation failed.",
  );
}
