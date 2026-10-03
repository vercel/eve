import { describe, expect, it } from "vitest";

import {
  AT,
  BUDGET_QUESTION,
  answer,
  cancel,
  heldOnBudget,
  message,
  overBudget,
} from "#internal/testing/human-input.js";

const { requestId } = BUDGET_QUESTION;

describe("the budget question", () => {
  it("running over budget asks once per violation and holds the turn until it is answered", () => {
    const asked = heldOnBudget();

    expect(asked.published("input.requested")).toEqual([
      { data: { ...AT, requests: [BUDGET_QUESTION] }, type: "input.requested" },
    ]);
    expect(asked.next()).toEqual({ held: "input" });

    const again = asked.stored().interrupt(overBudget({ ...AT, stepIndex: 1 }));
    expect(again.events).toEqual([]);
    expect(again.next()).toEqual({ held: "input" });
  });

  it("Continue grants a fresh budget window and the turn runs again", () => {
    const turn = heldOnBudget().intake(answer("continue", requestId));

    expect(turn.reported("budget.granted")).toHaveLength(1);
    expect(turn.resolutions()).toEqual([
      {
        kind: "session-limit",
        outcome: "answered",
        requestId,
        response: { optionId: "continue", requestId },
      },
    ]);
    expect(turn.next()).toEqual({ run: "model" });
    expect(turn.storesNothing()).toBe(true);
  });

  it("Stop resolves the question and cancels the turn", () => {
    const turn = heldOnBudget().intake(answer("stop", requestId));

    expect(turn.reported("budget.declined")).toEqual([{ requestId, type: "budget.declined" }]);
    expect(turn.reported("budget.granted")).toEqual([]);
    expect(turn.storesNothing()).toBe(true);
  });

  it("a typed reply that names an option answers it, and the turn does not read the reply", () => {
    const turn = heldOnBudget().intake(message("approve"));

    expect(turn.events[0]).toEqual({ type: "message.answered" });
    expect(turn.reported("budget.granted")).toHaveLength(1);
  });

  it("a cancel withdraws the question unanswered", () => {
    const turn = heldOnBudget().intake(cancel);

    expect(turn.resolutions()).toEqual([
      { kind: "session-limit", outcome: "cancelled", requestId },
    ]);
    expect(turn.storesNothing()).toBe(true);
  });

  it.each([
    { intake: message("Also check the invoices."), name: "a message that answers nothing" },
    { intake: answer("maybe", requestId), name: "an answer with neither option" },
  ])("$name leaves the question open and the turn held", ({ intake }) => {
    const turn = heldOnBudget().intake(intake);

    expect(turn.events).toEqual([]);
    expect(turn.next()).toEqual({ held: "input" });
  });

  it("a late answer to a closed budget question is dropped, not read as a message", () => {
    const closed = heldOnBudget().intake(answer("continue", requestId)).stored();

    const accepted = closed.humanInput.acceptInput({
      inputResponses: [{ optionId: "stop", requestId }],
    });

    expect(accepted).toEqual({ input: {} });
  });
});
