import type { InstrumentationAttemptScope } from "#instrumentation/lifecycle.js";
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
