import type { SessionStreamEvent } from "#protocol/session-event.js";
import { deriveRunFacts } from "#evals/runner/derive-run-facts.js";
import type { EveEvalToolCall } from "#evals/types.js";

/**
 * The tool calls in `events`, each pairing its `call.requested` with its `call.settled` by call
 * id: the same derivation as `turn.toolCalls`, for checks over a session's whole stream. `call.*`
 * facts carry ids rather than names, so this is how a check finds a named tool's output.
 */
export function toolCallsOf(events: readonly SessionStreamEvent[]): readonly EveEvalToolCall[] {
  return deriveRunFacts(events).toolCalls;
}
