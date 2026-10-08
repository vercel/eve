import type { EveEvalTurn } from "eve/evals";

/**
 * Whether every model step that asked for tools ran at least one of them. A
 * call through `eve__execute` whose input fails validation never becomes an action,
 * so a step that requested tools but produced no action had every call
 * rejected and the model had to try again.
 */
export function noCallRejectedWholesale(turn: EveEvalTurn): boolean {
  const stepsWithActions = new Set(
    turn.events.flatMap((event) =>
      event.type === "actions.requested" || event.type === "action.result"
        ? [`${event.data.turnId}:${event.data.stepIndex}`]
        : [],
    ),
  );
  return turn.events.every(
    (event) =>
      event.type !== "step.completed" ||
      event.data.finishReason !== "tool-calls" ||
      stepsWithActions.has(`${event.data.turnId}:${event.data.stepIndex}`),
  );
}
