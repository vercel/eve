import type {
  InstrumentationAttemptScope,
  InstrumentationUsage,
} from "#instrumentation/lifecycle.js";
import type { AgentTraceStateStore } from "#tracing/agent-trace-state.js";

/** Keeps the first model input so the turn-level invoke_agent span represents its task. */
export function rememberTurnInputMessages(
  store: AgentTraceStateStore,
  scope: InstrumentationAttemptScope,
  inputMessagesAttribute: string | undefined,
): void | PromiseLike<void> {
  if (inputMessagesAttribute === undefined) return;
  return store.updateTurn(scope.sessionId, scope.turnId, (turn) => ({
    ...turn,
    inputMessagesAttribute: turn.inputMessagesAttribute ?? inputMessagesAttribute,
  }));
}

/** Keeps the latest model output so the completed invoke_agent span represents its result. */
export function rememberTurnOutputMessages(
  store: AgentTraceStateStore,
  scope: InstrumentationAttemptScope,
  outputMessagesAttribute: string | undefined,
): void | PromiseLike<void> {
  if (outputMessagesAttribute === undefined) return;
  return store.updateTurn(scope.sessionId, scope.turnId, (turn) => ({
    ...turn,
    outputMessagesAttribute,
  }));
}

/** Accumulates completed model usage on the turn that owns the model call. */
export function recordTurnUsage(
  store: AgentTraceStateStore,
  scope: InstrumentationAttemptScope,
  usage: InstrumentationUsage,
): void | PromiseLike<void> {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return;
  return store.updateTurn(scope.sessionId, scope.turnId, (turn) => ({
    ...turn,
    modelUsage: {
      inputTokens:
        usage.inputTokens === undefined
          ? turn.modelUsage?.inputTokens
          : (turn.modelUsage?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens:
        usage.outputTokens === undefined
          ? turn.modelUsage?.outputTokens
          : (turn.modelUsage?.outputTokens ?? 0) + usage.outputTokens,
    },
  }));
}
