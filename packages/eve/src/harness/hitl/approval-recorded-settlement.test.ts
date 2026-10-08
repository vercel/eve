import { migrateSessionState } from "#harness/session-machine/migrate.js";
import { APPROVAL_STATE_KEY } from "#harness/session-machine/migrate-legacy.js";
import { describe, expect, it } from "vitest";

import { sessionView } from "#harness/session-machine/commit.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { ALICE, AT, approval, stepResponse } from "#internal/testing/hitl.js";
import { approversOf } from "./approved-call-callers.js";
import { beforeStep } from "./reducer.js";

const request = approval("deploy");
const LEGACY_KEY = APPROVAL_STATE_KEY;

function settlement(outcome: "allowed" | "cancelled") {
  return {
    actor: ALICE,
    ...(outcome === "allowed" && { approver: ALICE }),
    outcome,
    requestId: request.requestId,
    settledAt: 100,
  };
}

function legacyAudit(outcome: "allowed" | "cancelled") {
  return {
    activeCandidates: {},
    candidateHistory: [],
    nextCandidateSequence: 1,
    settlements: { [request.requestId]: settlement(outcome) },
  };
}

/** Settled, but the checkpoint was saved before its answer reached the step. */
function settledButWaiting(outcome: "allowed" | "cancelled", where: "legacy" | "machine") {
  const audit = legacyAudit(outcome);
  return {
    "eve.harness.turnState": {
      grants: [],
      suspended: [
        {
          event: AT,
          messages: stepResponse([request]),
          requests: [request],
          requester: ALICE,
          tasks: [],
        },
      ],
      ...(where === "machine" && { hitl: { audit } }),
    },
    ...(where === "legacy" && { [LEGACY_KEY]: audit }),
  };
}

describe("an approval settled before its answer reached the step", () => {
  it.each([
    ["allowed", "legacy"],
    ["cancelled", "legacy"],
    ["allowed", "machine"],
    ["cancelled", "machine"],
  ] as const)("applies a recorded %s settlement (%s audit) as its answer", (outcome, where) => {
    const state = migrateSessionState({ state: settledButWaiting(outcome, where) }).state;
    const decision = beforeStep(sessionView(storedProjection(state), state), []);
    expect(decision.transition.turn.suspended.flatMap((step) => step.requests)).toEqual([]);
    const resolved = decision.transition.events.flatMap((event) =>
      event.type === "input.resolved" ? event.data.resolutions : [],
    );
    expect(resolved).toEqual([
      expect.objectContaining({
        outcome: outcome === "allowed" ? "approved" : "denied",
        requestId: request.requestId,
      }),
    ]);
    // Nothing is settled again: the recorded settlement and its approver stand.
    expect(decision.transition.events.some((event) => event.type === "approval.settled")).toBe(
      false,
    );
    expect(decision.transition.turn.hitl?.audit?.settlements[request.requestId]).toEqual(
      settlement(outcome),
    );
    if (outcome === "allowed") {
      expect(decision.transition.turn.suspended[0]?.approved).toEqual([request]);
      expect(
        approversOf(decision.transition.turn.suspended[0]!.approved!, {
          ...sessionView(storedProjection(state), state),
          turn: decision.transition.turn,
        }),
      ).toEqual({ [request.action.callId]: ALICE });
    } else {
      expect(decision.transition.turn.suspended[0]?.approved ?? []).toEqual([]);
    }
  });

  it("applies it once", () => {
    const state = settledButWaiting("allowed", "machine");
    const view = sessionView(storedProjection(state), state);
    const first = beforeStep(view, []);
    const again = beforeStep({ ...view, turn: first.transition.turn }, []);
    expect(again.transition.events).toEqual([]);
    expect(again.transition.turn).toEqual(first.transition.turn);
  });

  it("leaves an unsettled approval waiting", () => {
    const state = settledButWaiting("allowed", "machine");
    const turn = state["eve.harness.turnState"];
    const unsettled = {
      "eve.harness.turnState": {
        ...turn,
        hitl: { ...turn.hitl, audit: { ...turn.hitl!.audit!, settlements: {} } },
      },
    };
    const decision = beforeStep(sessionView(storedProjection(unsettled), unsettled), []);
    expect(decision.transition.events).toEqual([]);
    expect(decision.transition.turn.suspended[0]?.requests).toEqual([request]);
  });
});

it("an approved call saved with the old audit still runs as its approver", () => {
  const state = {
    "eve.harness.turnState": {
      grants: [],
      suspended: [{ event: AT, messages: [], requests: [], approved: [request], tasks: [] }],
    },
    [LEGACY_KEY]: legacyAudit("allowed"),
  };
  const migrated = migrateSessionState({ state }).state;
  const view = sessionView(storedProjection(migrated), migrated);
  expect(approversOf(view.turn.suspended[0]!.approved!, view)).toEqual({
    [request.action.callId]: ALICE,
  });
});
