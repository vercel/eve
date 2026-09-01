import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  cancelActiveApprovalResponseAttempts,
  createApprovalCandidate,
  expireApprovalCandidates,
  finishApprovalCandidate,
  getApprovalAuditState,
  markApprovalCandidateAuthorizationRequired,
  settleAllowedCandidate,
  settleDirectApprovalResponse,
} from "#harness/hitl/approval-response-attempts.js";
import { getPendingAuthorization } from "#harness/authorization.js";
import type { SessionStateMap } from "#harness/types.js";

function responder(principalId: string): SessionAuthContext {
  return {
    attributes: { workspace: "T1" },
    authenticator: "slack-webhook",
    issuer: "slack:T1",
    principalId,
    principalType: "user",
  };
}

function create(input: {
  readonly candidateId: string;
  readonly deliveryId?: string;
  readonly principalId: string;
  readonly requestId?: string;
  readonly state?: SessionStateMap;
}) {
  return createApprovalCandidate({
    candidateIdPrefix: input.candidateId,
    createdAt: 100,
    deliveryId: input.deliveryId,
    expiresAt: 700,
    requestId: input.requestId ?? "request-1",
    responder: responder(input.principalId),
    state: input.state,
  });
}

describe("approval candidate state", () => {
  it("persists the complete responder while a candidate is active", () => {
    const transition = create({ candidateId: "candidate-1", deliveryId: "d1", principalId: "U1" });

    expect(transition.changed).toBe(true);
    expect(getApprovalAuditState(transition.state).activeCandidates).toEqual([
      {
        attemptId: `response-attempt:${JSON.stringify(["request-1", "d1"])}`,
        candidateId: "candidate-1",
        createdAt: 100,
        deliveryId: "d1",
        expiresAt: 700,
        requestId: "request-1",
        responder: {
          attributes: { workspace: "T1" },
          authenticator: "slack-webhook",
          issuer: "slack:T1",
          principalId: "U1",
          principalType: "user",
        },
        status: "pending",
      },
    ]);
  });

  it("does not collide when request and delivery ids contain separators", () => {
    const first = create({
      candidateId: "candidate-1",
      deliveryId: "c",
      principalId: "U1",
      requestId: "a:b",
    });
    const second = create({
      candidateId: "candidate-2",
      deliveryId: "b:c",
      principalId: "U1",
      requestId: "a",
      state: first.state,
    });

    expect(second.changed).toBe(true);
    expect(getApprovalAuditState(second.state).activeCandidates).toHaveLength(2);
  });

  it("deduplicates replay of the same requestId and deliveryId", () => {
    const first = create({ candidateId: "candidate-1", deliveryId: "d1", principalId: "U1" });
    const duplicate = create({
      candidateId: "candidate-1",
      deliveryId: "d1",
      principalId: "U1",
      state: first.state,
    });

    expect(duplicate.changed).toBe(false);
    expect(duplicate.state).toBe(first.state);
  });

  it("keeps direct legacy tests deterministic without deliveryId", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const duplicate = create({
      candidateId: "candidate-2",
      principalId: "U1",
      state: first.state,
    });

    expect(duplicate.changed).toBe(false);
  });

  it("creates competing attempts for distinct deliveryIds from the same responder", () => {
    const first = create({ candidateId: "candidate-1", deliveryId: "d1", principalId: "U1" });
    const second = create({
      candidateId: "candidate-2",
      deliveryId: "d2",
      principalId: "U1",
      state: first.state,
    });

    expect(second.changed).toBe(true);
    expect(getApprovalAuditState(second.state).activeCandidates).toHaveLength(2);
  });

  it("tracks authorization-required state and provider expiry", () => {
    const first = create({ candidateId: "candidate-1", deliveryId: "d1", principalId: "U1" });
    const state = markApprovalCandidateAuthorizationRequired({
      authorizationChallenges: [],
      candidateId: "candidate-1",
      expiresAt: 500,
      state: first.state,
    });

    expect(getApprovalAuditState(state).activeCandidates[0]).toMatchObject({
      expiresAt: 500,
      status: "authorization-required",
    });
  });

  it("stores authorization challenges in the ledger-owned authorization projection", () => {
    const first = create({ candidateId: "candidate-1", deliveryId: "d1", principalId: "U1" });
    const state = markApprovalCandidateAuthorizationRequired({
      authorizationChallenges: [
        {
          attemptId: "oauth-1",
          candidateId: "candidate-1",
          challenge: { url: "https://idp.example/oauth-1" },
          hookUrl: "https://eve.example/oauth-1",
          name: "github",
        },
      ],
      candidateId: "candidate-1",
      state: first.state,
    });

    expect(getPendingAuthorization(state)?.challenges).toEqual([
      expect.objectContaining({ attemptId: "oauth-1", candidateId: "candidate-1", name: "github" }),
    ]);
  });

  it("projects the responder to narrow identity in terminal history", () => {
    const first = create({ candidateId: "candidate-1", deliveryId: "d1", principalId: "U1" });
    const state = finishApprovalCandidate({
      candidateId: "candidate-1",
      completedAt: 200,
      state: first.state,
      status: "rejected",
    });

    expect(getApprovalAuditState(state).candidateHistory[0]?.responder).toEqual({
      authenticator: "slack-webhook",
      issuer: "slack:T1",
      principalId: "U1",
      principalType: "user",
    });
  });

  it("persists safe rejection feedback and permits a later retry", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const rejected = finishApprovalCandidate({
      candidateId: "candidate-1",
      completedAt: 200,
      reason: "GitHub write permission is required.",
      state: first.state,
      status: "rejected",
    });
    const retry = create({
      candidateId: "candidate-1",
      principalId: "U1",
      state: rejected,
    });

    expect(getApprovalAuditState(retry.state).candidateHistory).toEqual([
      expect.objectContaining({
        candidateId: "candidate-1",
        reason: "GitHub write permission is required.",
        status: "rejected",
      }),
    ]);
    expect(retry.changed).toBe(true);
  });

  it("force-closes every active response attempt", () => {
    const first = create({ candidateId: "candidate-1", deliveryId: "d1", principalId: "U1" });
    const second = create({
      candidateId: "candidate-2",
      deliveryId: "d2",
      principalId: "U2",
      state: first.state,
    });

    const state = cancelActiveApprovalResponseAttempts({ completedAt: 300, state: second.state });
    const audit = getApprovalAuditState(state);

    expect(audit.activeCandidates).toEqual([]);
    expect(audit.candidateHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ candidateId: "candidate-1", status: "stale" }),
        expect.objectContaining({ candidateId: "candidate-2", status: "stale" }),
      ]),
    );
  });

  it("expires stale candidates intrinsically before creating another candidate", () => {
    const first = create({ candidateId: "candidate-1", deliveryId: "d1", principalId: "U1" });
    const next = createApprovalCandidate({
      candidateIdPrefix: "candidate-2",
      createdAt: 800,
      deliveryId: "d2",
      expiresAt: 1_400,
      requestId: "request-1",
      responder: responder("U2"),
      state: first.state,
    });

    expect(getApprovalAuditState(next.state)).toMatchObject({
      activeCandidates: [expect.objectContaining({ candidateId: "candidate-2" })],
      candidateHistory: [
        expect.objectContaining({ candidateId: "candidate-1", status: "timed-out" }),
      ],
    });
  });

  it("expires only candidates whose deadline has passed", () => {
    const first = create({ candidateId: "candidate-1", deliveryId: "d1", principalId: "U1" });
    const second = createApprovalCandidate({
      candidateIdPrefix: "candidate-2",
      createdAt: 100,
      deliveryId: "d2",
      expiresAt: 900,
      requestId: "request-1",
      responder: responder("U2"),
      state: first.state,
    });
    const state = expireApprovalCandidates({ now: 800, state: second.state });
    const audit = getApprovalAuditState(state);

    expect(audit.activeCandidates.map((candidate) => candidate.candidateId)).toEqual([
      "candidate-2",
    ]);
    expect(audit.candidateHistory).toEqual([
      expect.objectContaining({ candidateId: "candidate-1", status: "timed-out" }),
    ]);
  });

  it("atomically settles the first allowed candidate and stales competitors", () => {
    const first = create({ candidateId: "candidate-1", deliveryId: "d1", principalId: "U1" });
    const second = create({
      candidateId: "candidate-2",
      deliveryId: "d2",
      principalId: "U2",
      state: first.state,
    });
    const winner = settleAllowedCandidate({
      candidateId: "candidate-2",
      settledAt: 300,
      state: second.state,
    });
    const late = settleAllowedCandidate({
      candidateId: "candidate-1",
      settledAt: 400,
      state: winner.state,
    });
    const audit = getApprovalAuditState(late.state);

    expect(winner.changed).toBe(true);
    expect(late.changed).toBe(false);
    expect(audit.activeCandidates).toEqual([]);
    expect(audit.candidateHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ candidateId: "candidate-1", status: "stale" }),
        expect.objectContaining({ candidateId: "candidate-2", status: "allowed" }),
      ]),
    );
  });

  it("lets Cancel win atomically and stales every Allow candidate", () => {
    const first = create({ candidateId: "candidate-1", deliveryId: "d1", principalId: "U1" });
    const cancelled = settleDirectApprovalResponse({
      actor: responder("U2"),
      outcome: "cancelled",
      requestId: "request-1",
      settledAt: 250,
      state: first.state,
    });
    const late = settleAllowedCandidate({
      candidateId: "candidate-1",
      settledAt: 300,
      state: cancelled.state,
    });

    expect(cancelled.changed).toBe(true);
    expect(late.changed).toBe(false);
  });

  it("does not let a candidate start after terminal settlement", () => {
    const first = create({ candidateId: "candidate-1", deliveryId: "d1", principalId: "U1" });
    const settled = settleAllowedCandidate({
      candidateId: "candidate-1",
      settledAt: 300,
      state: first.state,
    });
    const late = create({
      candidateId: "candidate-2",
      deliveryId: "d2",
      principalId: "U2",
      state: settled.state,
    });

    expect(late.changed).toBe(false);
  });
});
