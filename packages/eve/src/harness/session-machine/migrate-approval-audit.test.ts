import { expect, it } from "vitest";
import { sessionView } from "#harness/session-machine/commit.js";
import { migrateSessionState } from "#harness/session-machine/migrate.js";
import { initialSessionProjection } from "#protocol/session-projection.js";
import { ALICE as alice, AT, approval, stepResponse } from "#internal/testing/hitl.js";
import { approversOf } from "#harness/hitl/approved-call-callers.js";
import { beforeStep } from "#harness/hitl/reducer.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { writeTurnState } from "#harness/session-machine/state.js";

const at = { sequence: 1, stepIndex: 0, turnId: "t1" };
const request = {
  kind: "tool-approval" as const,
  requestId: "r1",
  prompt: "Approve deploy?",
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel" },
  ],
  action: { kind: "tool-call" as const, callId: "c1", toolName: "deploy", input: {} },
};
const turn = {
  grants: [],
  suspended: [{ event: at, messages: [], requests: [request], requester: alice, tasks: [] }],
};
const audit = {
  activeCandidates: {},
  candidateHistory: [],
  nextCandidateSequence: 3,
  settlements: {
    r1: { actor: alice, approver: alice, outcome: "allowed", requestId: "r1", settledAt: 123 },
  },
};
function savedSession() {
  return {
    state: {
      "eve.harness.turnState": {
        ...turn,
        suspended: [{ ...turn.suspended[0], requests: [], approved: [request] }],
      },
      "eve.runtime.hitl.approvalState": audit,
    },
  };
}
it("preserves Owen's persisted approval audit on hydration", () => {
  const saved = migrateSessionState(savedSession());
  expect(
    sessionView(initialSessionProjection(), saved.state).turn.hitl?.audit?.settlements.r1?.approver,
  ).toEqual(alice);
  expect(saved.state["eve.runtime.hitl.approvalState"]).toBeUndefined();
});
it("resumes an approved call as its approver and hydrates idempotently", () => {
  const saved = migrateSessionState(savedSession());
  const view = sessionView(initialSessionProjection(), saved.state);
  expect(approversOf(view.turn.suspended[0]!.approved!, view)).toEqual({ c1: alice });
  expect(migrateSessionState(saved)).toEqual(saved);
});
it("removes the old approval key in the hydration write", () => {
  expect(migrateSessionState(savedSession()).state).not.toHaveProperty(
    "eve.runtime.hitl.approvalState",
  );
});
it("maps candidate challenges, retains history, and lets machine audit win duplicates", () => {
  const candidate = {
    candidateId: "candidate",
    requestId: "r2",
    createdAt: 1,
    expiresAt: 100,
    responder: alice,
    decision: "approve" as const,
    status: "authorization-required" as const,
    authorizationChallenges: [{ name: "github", candidateId: "candidate" }],
  };
  const history = {
    ...candidate,
    candidateId: "finished",
    status: "allowed" as const,
    completedAt: 2,
  };
  const saved = migrateSessionState({
    state: {
      ...savedSession().state,
      "eve.runtime.hitl.approvalState": {
        ...audit,
        activeCandidates: { candidate },
        candidateHistory: [history],
      },
    },
  });
  const upgraded = sessionView(initialSessionProjection(), saved.state).turn.hitl!.audit!;
  expect(upgraded.activeCandidates.candidate?.authorizations).toEqual(
    candidate.authorizationChallenges,
  );
  expect(upgraded.candidateHistory).toEqual([history]);
  expect(upgraded.nextCandidateSequence).toBe(3);
  const mixed = migrateSessionState({
    state: {
      ...saved.state,
      "eve.runtime.hitl.approvalState": {
        ...audit,
        settlements: {
          r1: { ...audit.settlements.r1, approver: undefined },
          r2: { ...audit.settlements.r1, requestId: "r2" },
        },
        nextCandidateSequence: 99,
        activeCandidates: { candidate: { ...candidate, expiresAt: 999 } },
        candidateHistory: [
          { ...history, candidateId: "older", reason: "legacy-only" },
          { ...history, reason: "obsolete duplicate" },
        ],
      },
    },
  });
  const merged = sessionView(initialSessionProjection(), mixed.state).turn.hitl!.audit!;
  expect(merged.settlements.r1?.approver).toEqual(alice);
  expect(merged.settlements.r2?.approver).toEqual(alice);
  expect(merged.activeCandidates.candidate?.expiresAt).toBe(100);
  expect(merged.candidateHistory).toEqual([
    { ...history, candidateId: "older", reason: "legacy-only" },
    history,
  ]);
  expect(merged.nextCandidateSequence).toBe(3);
  expect(migrateSessionState(mixed)).toEqual(mixed);
});
it("never restores the old approval key when resumed candidates expire", () => {
  const gated = approval("deploy", "r2");
  const resumed = migrateSessionState({
    state: {
      "eve.harness.turnState": {
        ...turn,
        suspended: [{ ...turn.suspended[0], requests: [gated] }],
      },
      "eve.runtime.hitl.approvalState": {
        ...audit,
        activeCandidates: {
          c: {
            candidateId: "c",
            createdAt: 200,
            decision: "approve",
            expiresAt: 1_000,
            requestId: "r2",
            responder: alice,
            status: "pending",
          },
        },
        settlements: {
          ...audit.settlements,
          r3: {
            actor: alice,
            approver: alice,
            outcome: "allowed",
            requestId: "r3",
            settledAt: 300,
          },
        },
      },
    },
  }).state;
  const decision = beforeStep(sessionView(storedProjection(resumed), resumed), [
    { type: "time", now: 1_001 },
  ]);
  const saved = writeTurnState({ state: resumed }, decision.transition.turn).state;
  expect(saved).not.toHaveProperty("eve.runtime.hitl.approvalState");
  const upgraded = sessionView(storedProjection(saved), saved).turn.hitl!.audit!;
  expect(upgraded.activeCandidates).toEqual({});
  expect(upgraded.candidateHistory).toEqual([
    expect.objectContaining({ candidateId: "c", status: "timed-out" }),
  ]);
  expect(upgraded.settlements.r1?.approver).toEqual(alice);
  expect(upgraded.settlements.r3?.approver).toEqual(alice);
});
it("defaults legacy candidates without decisions to Approve and derives missing sequences", () => {
  const saved = migrateSessionState({
    state: {
      "eve.runtime.hitl.approvalState": {
        activeCandidates: {
          c: {
            candidateId: "c",
            createdAt: 100,
            expiresAt: 700,
            requestId: "r2",
            responder: alice,
            status: "pending",
          },
        },
        candidateHistory: [
          { candidateId: "finished", requestId: "r1", status: "rejected", responder: alice },
        ],
        settlements: {},
      },
    },
  });
  const upgraded = sessionView(storedProjection(saved.state), saved.state).turn.hitl!.audit!;
  expect(upgraded.activeCandidates.c?.decision).toBe("approve");
  expect(upgraded.nextCandidateSequence).toBe(2);
});
it.each(["allowed", "cancelled"] as const)(
  "upgrades a %s settlement whose answer hadn't reached its step, once",
  (outcome) => {
    const gated = approval("deploy");
    const saved = migrateSessionState({
      state: {
        "eve.harness.turnState": {
          grants: [],
          suspended: [
            {
              event: AT,
              messages: stepResponse([gated]),
              requests: [gated],
              requester: alice,
              tasks: [],
            },
          ],
        },
        "eve.runtime.hitl.approvalState": {
          activeCandidates: {},
          candidateHistory: [],
          nextCandidateSequence: 1,
          settlements: {
            [gated.requestId]: {
              actor: alice,
              ...(outcome === "allowed" && { approver: alice }),
              outcome,
              requestId: gated.requestId,
              settledAt: 100,
            },
          },
        },
      },
    });
    expect(migrateSessionState(saved)).toEqual(saved);
    const view = sessionView(storedProjection(saved.state), saved.state);
    const decision = beforeStep(view, [{ type: "time", now: 101 }]);
    expect(decision.transition.turn.suspended.flatMap((step) => step.requests)).toEqual([]);
    if (outcome === "allowed") {
      expect(decision.transition.turn.suspended[0]?.approved).toEqual([gated]);
      expect(
        approversOf(decision.transition.turn.suspended[0]!.approved!, {
          ...view,
          turn: decision.transition.turn,
        }),
      ).toEqual({ [gated.action.callId]: alice });
    }
  },
);
