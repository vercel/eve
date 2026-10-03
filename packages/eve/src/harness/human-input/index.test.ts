import { describe, expect, it } from "vitest";

import {
  BOB,
  NOW,
  Turn,
  answer,
  approval,
  approvalsRequested,
  callback,
  cancel,
  challenge,
  heldOnApprovals,
  message,
  overBudget,
  signInRequired,
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
  "Alice's call needs a sign-in": (turn) => turn.interrupt(signInRequired([challenge("a1")])),
  "the sign-in calls back": (turn) => turn.intake(callback("a1")),
  "Alice's step asks for a guarded release": (turn) =>
    turn.interrupt(
      approvalsRequested([approval("release")], { responsePolicyRequestIds: ["release"] }),
    ),
  "Bob approves the release": (turn) => turn.intake(answer("approve", "release", BOB)),
  "the release policy allows Bob": (turn) => {
    const check = turn.reported("responder.check").at(-1);
    if (check === undefined) return turn;
    return turn.intake({
      candidateId: check.candidateId,
      ran: { kind: "returned", value: { status: "allowed" } },
      type: "responder.checked",
    });
  },
  "ten minutes pass": (turn) => turn.intake({ now: NOW + 10 * 60_000, type: "time" }),
  "Bob's child asks to deploy": (turn) =>
    turn.interrupt({
      at: { sequence: 4, stepIndex: 2, turnId: "child_turn_0" },
      requests: [approval("deploy", "child-deploy")],
      route: { childContinuationToken: "bob-token" },
      type: "relayed.requested",
    }),
  "Alice's answer for Bob's child arrives": (turn) =>
    turn.intake({
      responses: [{ optionId: "approve", requestId: "child-deploy" }],
      type: "delivered",
    }),
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

  it("the model never runs while a request of the turn's own is open", () => {
    const ranWhileOpen: string[] = [];
    for (const sequence of sequences(3)) {
      let turn = Turn.idle();
      for (const name of sequence) {
        turn = ACTIONS[name]!(turn).stored();
        const open =
          turn.humanInput.openRequestIds().size > 0 || turn.humanInput.awaitedSignIns().length > 0;
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
