import type { EveEvalTurn } from "eve/evals";

/**
 * Whether every model run that asked for tools ran at least one of them. A
 * call through `eve__tool` whose input fails validation never becomes a call,
 * so a run that finished for tool calls but requested none had every call
 * rejected and the model had to try again.
 */
export function noCallRejectedWholesale(turn: EveEvalTurn): boolean {
  const runsWithCalls = new Set(
    turn.events.flatMap((event) =>
      event.type === "call.requested" && "runId" in event.data.owner
        ? [event.data.owner.runId]
        : [],
    ),
  );
  return turn.events.every(
    (event) =>
      event.type !== "model.settled" ||
      event.data.finishReason !== "tool-calls" ||
      runsWithCalls.has(event.data.runId),
  );
}
