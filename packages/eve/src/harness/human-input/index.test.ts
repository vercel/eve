import { describe, expect, it } from "vitest";

import {
  AT,
  Turn,
  answer,
  approval,
  approvalsRequested,
  cancel,
  heldOnApprovals,
  message,
  overBudget,
} from "#internal/testing/human-input.js";

/** What a person or the runtime can do to a turn, by name. */
const ACTIONS: Readonly<Record<string, (turn: Turn) => Turn>> = {
  "Alice's step asks to send_email and deploy": (turn) =>
    turn.interrupt(approvalsRequested([approval("send_email"), approval("deploy")])),
  "Alice approves send_email": (turn) => turn.intake(answer("approve", "send_email")),
  "Alice cancels deploy": (turn) => turn.intake(answer("cancel", "deploy")),
  "Alice types Approve": (turn) => turn.intake(message("Approve")),
  "Alice types something else": (turn) => turn.intake(message("Check the invoices first.")),
  "the turn is cancelled": (turn) => turn.intake(cancel),
  "the session runs over budget": (turn) => turn.interrupt(overBudget()),
  "Alice continues past the budget": (turn) => turn.intake(answer("continue", "s:limit:input:12")),
};

/** Every sequence of up to `length` actions, by name. */
function sequences(length: number): string[][] {
  if (length === 0) return [[]];
  const shorter = sequences(length - 1);
  return [
    ...shorter,
    ...shorter
      .filter((sequence) => sequence.length === length - 1)
      .flatMap((sequence) => Object.keys(ACTIONS).map((name) => [...sequence, name])),
  ];
}

describe("HumanInput", () => {
  it("a turn with nothing open runs the model and leaves the rest of the session state alone", () => {
    const { humanInput } = Turn.idle();

    expect(humanInput.next()).toEqual({ run: "model" });
    expect(humanInput.write({ other: 1 })).toEqual({ other: 1 });
  });

  it("a request eve cannot ask for yet fails the turn instead of holding it", () => {
    const turn = Turn.idle().interrupt({
      at: AT,
      requests: [
        {
          action: { callId: "call-ask", input: {}, kind: "tool-call", toolName: "ask" },
          kind: "question",
          prompt: "Where should Bob deploy?",
          requestId: "ask",
        },
      ],
      route: { childContinuationToken: "bob-token" },
      type: "relayed.requested",
    });

    expect(turn.reported("turn.failed")).toEqual([
      expect.objectContaining({ code: "HUMAN_INPUT_UNAVAILABLE" }),
    ]);
    expect(turn.next()).toEqual({ run: "model" });
  });

  it("the model never runs while a request of the turn's own is open", () => {
    const ranWhileOpen: string[] = [];
    for (const sequence of sequences(3)) {
      let turn = Turn.idle();
      for (const name of sequence) {
        turn = ACTIONS[name]!(turn).stored();
        const open = turn.humanInput.openRequestIds().size > 0;
        if (open && "run" in turn.next()) ranWhileOpen.push(sequence.join(" → "));
      }
    }

    expect(ranWhileOpen).toEqual([]);
  });

  it("an answer to a request that is no longer open becomes text that authorizes nothing", () => {
    const { humanInput } = heldOnApprovals("deploy");

    const { displayMessage, input } = humanInput.acceptInput({
      inputResponses: [
        { optionId: "approve", requestId: "closed" },
        { optionId: "approve", requestId: "deploy" },
      ],
    });

    expect(input?.inputResponses).toEqual([{ optionId: "approve", requestId: "deploy" }]);
    expect(input?.message).toEqual(
      expect.stringContaining("This does not authorize an earlier action"),
    );
    expect(displayMessage).toBe("approve");
  });
});
