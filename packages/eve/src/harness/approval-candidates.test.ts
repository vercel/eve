import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  createApprovalCandidate,
  expireApprovalCandidates,
  finishApprovalCandidate,
  getApprovalAuditState,
  markApprovalCandidateAuthorizationRequired,
  settleAllowedCandidate,
  settleDirectApprovalResponse,
} from "#harness/approval-candidates.js";
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
  readonly principalId: string;
  readonly requestId?: string;
  readonly state?: SessionStateMap;
}) {
  return createApprovalCandidate({
    candidateIdPrefix: input.candidateId,
    createdAt: 100,
    expiresAt: 700,
    requestId: input.requestId ?? "request-1",
    responder: responder(input.principalId),
    state: input.state,
  });
}

describe("approval candidate state", () => {
  it("persists the complete responder while a candidate is active", () => {
    const transition = create({ candidateId: "candidate-1", principalId: "U1" });

    expect(transition.changed).toBe(true);
    expect(getApprovalAuditState(transition.state).activeCandidates).toEqual([
      {
        candidateId: "candidate-1",
        createdAt: 100,
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

  it("silently deduplicates one responder's active candidate", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const duplicate = create({
      candidateId: "candidate-1",
      principalId: "U1",
      state: first.state,
    });

    expect(duplicate.changed).toBe(false);
    expect(duplicate.state).toBe(first.state);
  });

  it("defensively deduplicates the same responder under another id", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const duplicate = create({
      candidateId: "candidate-2",
      principalId: "U1",
      state: first.state,
    });

    expect(duplicate.changed).toBe(false);
  });

  it("allows different responders to validate concurrently", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const second = create({
      candidateId: "candidate-2",
      principalId: "U2",
      state: first.state,
    });

    expect(second.changed).toBe(true);
    expect(getApprovalAuditState(second.state).activeCandidates).toHaveLength(2);
  });

  it("tracks authorization-required state and provider expiry", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
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

  it("projects the responder to narrow identity in terminal history", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
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
      safeReason: "GitHub write permission is required.",
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
        safeReason: "GitHub write permission is required.",
        status: "rejected",
      }),
    ]);
    expect(retry.changed).toBe(true);
  });

  it("expires stale candidates intrinsically before creating another candidate", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const next = createApprovalCandidate({
      candidateIdPrefix: "candidate-2",
      createdAt: 800,
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
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const second = createApprovalCandidate({
      candidateIdPrefix: "candidate-2",
      createdAt: 100,
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
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const second = create({
      candidateId: "candidate-2",
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
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
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
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const settled = settleAllowedCandidate({
      candidateId: "candidate-1",
      settledAt: 300,
      state: first.state,
    });
    const late = create({
      candidateId: "candidate-2",
      principalId: "U2",
      state: settled.state,
    });

    expect(late.changed).toBe(false);
  });

  it("keeps unrelated requests active when another request settles", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const unrelated = create({
      candidateId: "candidate-2",
      principalId: "U2",
      requestId: "request-2",
      state: first.state,
    });
    const settled = settleAllowedCandidate({
      candidateId: "candidate-1",
      settledAt: 300,
      state: unrelated.state,
    });

    expect(getApprovalAuditState(settled.state).activeCandidates).toEqual([
      expect.objectContaining({ candidateId: "candidate-2", requestId: "request-2" }),
    ]);
  });
});
