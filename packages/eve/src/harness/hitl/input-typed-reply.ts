import { resolveTextToResponses } from "#channel/resolve-text.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

import type { SessionView } from "#harness/session-machine/view.js";
import { openApprovalsOf } from "./approval.js";

/**
 * The answers a person's typed reply gives, when it names an option of a
 * request text can answer. The turn's own: the budget question while it is
 * open, otherwise each approval still unanswered that no response policy
 * guards, since a policy needs to know who answered. Relayed: the one
 * relayed question waiting, when only one is. A reply that names no option
 * answers nothing.
 */
export function typedAnswers(
  state: SessionView,
  text: string,
  of: "own" | "relayed",
): readonly InputResponse[] {
  const inputs = Object.values(state.projection.inputs).filter(
    (input) => input.status !== "settled",
  );
  if (of === "relayed") {
    const questions = inputs.filter(
      (input) =>
        input.request.kind === "question" &&
        state.turn.hitl?.relayedRoutes?.[input.request.requestId] !== undefined,
    );
    return questions.length === 1 ? answersTo(text, questions) : [];
  }
  const budget = answersTo(
    text,
    inputs.filter(
      (input) =>
        input.request.kind === "session-limit" &&
        state.turn.hitl?.relayedRoutes?.[input.request.requestId] === undefined,
    ),
  );
  if (budget.length > 0) return budget;
  return answersTo(
    text,
    openApprovalsOf(state).flatMap((request) =>
      request.kind === "tool-approval" &&
      request.answer === undefined &&
      request.responsePolicy !== true
        ? [request]
        : [],
    ),
  );
}

function answersTo(
  text: string,
  open: readonly { readonly request: InputRequest }[],
): readonly InputResponse[] {
  return resolveTextToResponses(
    text,
    open.map(({ request }) => request),
  );
}
