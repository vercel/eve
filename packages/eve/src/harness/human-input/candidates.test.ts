import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import type { Intake, PolicyRun } from "#harness/human-input/index.js";
import {
  ALICE,
  AT,
  BOB,
  CAROL,
  NOW,
  Turn,
  answer,
  approval,
  approvalsRequested,
  callback,
  cancel,
  challenge,
  message,
} from "#internal/testing/human-input.js";

/** A turn held on Alice's approval of `deploy`, whose response policy decides who may answer. */
function guarded(): Turn {
  return Turn.idle().interrupt(
    approvalsRequested([approval("deploy")], { responsePolicyRequestIds: ["deploy"] }),
  );
}

function answerAs(responder: SessionAuthContext | null, optionId = "approve"): Intake {
  return answer(optionId, "deploy", responder);
}

/** The candidate whose policy the runtime was asked to run last. */
function checkedId(turn: Turn): string {
  return turn.reported("responder.check").at(-1)!.candidateId;
}

/** The runtime ran the policy for `turn`'s last candidate, and it did this. */
function policyRan(turn: Turn, ran: PolicyRun): Turn {
  return turn.intake({ candidateId: checkedId(turn), ran, type: "responder.checked" });
}

const ALLOWED: PolicyRun = { kind: "returned", value: { status: "allowed" } };

function candidates(turn: Turn) {
  return turn.published("approval.candidate").map(({ data }) => ({
    outcome: data.outcome,
    reason: data.reason,
    responder: data.responderPrincipalId,
  }));
}

/** Bob answered `answered`'s approval, and his policy asks him to sign in to "reviewer" first. */
function bobMustSignIn(answered = guarded().intake(answerAs(BOB))): Turn {
  return policyRan(answered, {
    challenges: [challenge("r1", { name: "reviewer", principalId: "bob", requester: BOB })],
    kind: "threw",
  });
}

describe("approval response policies", () => {
  it("an answer becomes a candidate the policy checks, and the turn stays held", () => {
    const turn = guarded().intake(answerAs(BOB));

    expect(candidates(turn)).toEqual([{ outcome: "pending", reason: undefined, responder: "bob" }]);
    expect(turn.reported("responder.check")).toEqual([
      expect.objectContaining({
        at: AT,
        decision: "approve",
        request: approval("deploy"),
        requester: ALICE,
        responder: BOB,
      }),
    ]);
    expect(turn.resolutions()).toEqual([]);
    expect(turn.next()).toEqual({ held: "input" });
  });

  it("typed text never answers a guarded approval; it steers past it", () => {
    const turn = guarded().intake(message("approve"));

    expect(turn.reported("message.answered")).toEqual([]);
    expect(turn.reported("calls.approved")).toEqual([]);
    expect(turn.resolutions().map(({ outcome }) => outcome)).toEqual(["ignored"]);
  });

  it("the first allowed candidate settles the approval, and its competitors go stale", () => {
    const answered = guarded().intake(answerAs(BOB)).intake(answerAs(CAROL));

    const turn = policyRan(answered, ALLOWED);

    expect(candidates(turn)).toEqual([
      { outcome: "stale", reason: "Another response settled this approval.", responder: "bob" },
    ]);
    expect(turn.published("approval.settled").map(({ data }) => data)).toEqual([
      expect.objectContaining({ outcome: "approved", responderPrincipalId: "carol" }),
    ]);
    expect(turn.reported("calls.approved")).toEqual([
      { at: AT, requests: [approval("deploy")], type: "calls.approved" },
    ]);
    expect(turn.next()).toEqual({ run: "model" });
  });

  it("a verdict for a candidate that went stale changes nothing", () => {
    const bobs = guarded().intake(answerAs(BOB));
    const settled = policyRan(bobs.intake(answerAs(CAROL)), ALLOWED);

    const late = settled.intake({
      candidateId: checkedId(bobs),
      ran: ALLOWED,
      type: "responder.checked",
    });

    expect(late.events).toEqual([]);
  });

  it("an allowed Cancel settles the approval as denied, and the call never runs", () => {
    const turn = policyRan(guarded().intake(answerAs(ALICE, "cancel")), ALLOWED);

    expect(turn.published("approval.settled")[0]?.data.outcome).toBe("cancelled");
    expect(turn.resolutions().map(({ outcome }) => outcome)).toEqual(["denied"]);
    expect(turn.reported("calls.approved")).toEqual([]);
  });

  it("a rejected candidate leaves the approval open, and a retry is a fresh candidate", () => {
    const first = guarded().intake(answerAs(BOB));
    const rejected = policyRan(first, {
      kind: "returned",
      value: { reason: "Wrong responder.", status: "rejected" },
    });

    expect(candidates(rejected)).toEqual([
      { outcome: "rejected", reason: "Wrong responder.", responder: "bob" },
    ]);
    expect(rejected.next()).toEqual({ held: "input" });
    expect(checkedId(rejected.stored().intake(answerAs(BOB)))).not.toBe(checkedId(first));
  });

  it("a repeat of an active candidate is ignored, but a changed decision is a new candidate", () => {
    const answered = guarded().intake(answerAs(BOB));

    expect(answered.intake(answerAs(BOB)).events).toEqual([]);
    expect(answered.intake(answerAs(BOB, "cancel")).reported("responder.check")).toHaveLength(1);
  });

  it("an answer from nobody signed in is refused", () => {
    const turn = guarded().intake(answerAs(null));

    expect(turn.reported("responder.check")).toEqual([]);
    expect(turn.published("message.completed").map(({ data }) => data.message)).toEqual([
      "Authentication is required to respond to this approval.",
    ]);
  });

  it("a policy that failed fails its candidate and leaves the approval open", () => {
    const turn = policyRan(guarded().intake(answerAs(BOB)), { kind: "threw" });

    expect(candidates(turn)).toEqual([
      {
        outcome: "failed",
        reason: "We couldn’t verify your response. Please try again.",
        responder: "bob",
      },
    ]);
    expect(turn.next()).toEqual({ held: "input" });
  });

  it("a policy that asks the responder to sign in holds on it, then checks again as them", () => {
    const answered = guarded().intake(answerAs(BOB));
    const candidateId = checkedId(answered);
    const signIn = bobMustSignIn(answered);

    expect(signIn.published("authorization.required")[0]?.data).toMatchObject({
      attemptId: "r1",
      candidateId,
      principalId: "bob",
    });
    expect(signIn.humanInput.awaitedSignIns()).toEqual(["r1"]);

    const turn = signIn.intake(callback("r1", "reviewer"));
    // The responder's sign-in binds the responder, so the turn keeps Alice as its person.
    expect(turn.reported("sign-in.completed")).toEqual([
      expect.objectContaining({ requester: null }),
    ]);
    expect(turn.reported("responder.check")).toEqual([
      expect.objectContaining({ candidateId, responder: BOB }),
    ]);
  });

  it("a candidate times out after ten minutes, failing its sign-in and ignoring its callback", () => {
    const signIn = bobMustSignIn();

    expect(signIn.intake({ now: NOW + 10 * 60_000 - 1, type: "time" }).events).toEqual([]);
    const turn = signIn.intake({ now: NOW + 10 * 60_000, type: "time" });

    expect(candidates(turn)).toEqual([
      { outcome: "timed-out", reason: undefined, responder: "bob" },
    ]);
    expect(turn.published("authorization.completed").map(({ data }) => data)).toEqual([
      expect.objectContaining({
        outcome: "failed",
        reason: "The approval response expired. Please submit a new response.",
      }),
    ]);
    expect(turn.humanInput.openRequestIds()).toEqual(new Set(["deploy"]));
    expect(turn.intake(callback("r1", "reviewer")).events).toEqual([]);
  });

  it.each([
    { intake: message("Never mind, just say hello."), name: "a message" },
    { intake: cancel, name: "a cancel" },
  ])("$name stales active candidates and declines their sign-ins silently", ({ intake }) => {
    const turn = bobMustSignIn().intake(intake);

    expect(candidates(turn).map(({ outcome }) => outcome)).toEqual(["stale"]);
    expect(turn.published("authorization.completed").map(({ data }) => data.outcome)).toEqual([
      "declined",
    ]);
    // Only the turn's own sign-ins are named to the model.
    expect(turn.reported("note")).toEqual([]);
    expect(turn.next()).toEqual({ run: "model" });
  });
});
