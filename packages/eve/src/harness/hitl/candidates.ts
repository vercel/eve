import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionStateMap } from "#harness/types.js";

import { readApprovalState, writeApprovalState } from "./requests.js";

type ApprovalCandidateStatus =
  | "pending"
  | "authorization-required"
  | "allowed"
  | "rejected"
  | "failed"
  | "timed-out"
  | "stale";

/** What a responder submitted: a candidate settles its request this way once allowed. */
export type ApprovalCandidateDecision = "approve" | "cancel";

interface ApprovalCandidateAuditRecord {
  readonly candidateId: string;
  readonly decision: ApprovalCandidateDecision;
  readonly requestId: string;
  readonly responder: ApprovalResponderIdentity;
  readonly status: ApprovalCandidateStatus;
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly expiresAt?: number;
  readonly reason?: string;
}

export interface ApprovalResponderIdentity {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
}

export interface ApprovalSettlementAuditRecord {
  readonly actor: ApprovalResponderIdentity;
  /** `unavailable`: the request's entry was gone, so its call is reported unavailable, never run. */
  readonly outcome: "allowed" | "cancelled" | "unavailable";
  readonly requestId: string;
  readonly settledAt: number;
  readonly candidateId?: string;
}

export interface ActiveApprovalCandidate {
  readonly candidateId: string;
  readonly decision: ApprovalCandidateDecision;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
  readonly status: "pending" | "authorization-required";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly authorizationChallenges?: readonly AuthorizationChallenge[];
}

export interface DurableApprovalState {
  readonly activeCandidates: Readonly<Record<string, ActiveApprovalCandidate>>;
  readonly nextCandidateSequence: number;
  readonly candidateHistory: readonly ApprovalCandidateAuditRecord[];
  readonly settlements: Readonly<Record<string, ApprovalSettlementAuditRecord>>;
}

interface ApprovalStateTransition {
  readonly changed: boolean;
  readonly state: SessionStateMap | undefined;
}

/** Creates or deduplicates one responder's candidate decision for a pending request. */
export function createApprovalCandidate(input: {
  readonly candidateIdPrefix: string;
  readonly createdAt: number;
  readonly decision: ApprovalCandidateDecision;
  readonly expiresAt: number;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
  readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition {
  const expiredState = expireApprovalCandidates({ now: input.createdAt, state: input.state });
  const approvalState = readApprovalState(expiredState);
  const settlement = approvalState.settlements[input.requestId];
  if (settlement !== undefined) {
    return { changed: false, state: expiredState };
  }

  const responder = input.responder;
  const duplicate = Object.values(approvalState.activeCandidates).find(
    (candidate) =>
      candidate.requestId === input.requestId &&
      candidate.decision === input.decision &&
      sameResponder(candidate.responder, responder),
  );
  if (duplicate !== undefined) {
    return { changed: false, state: expiredState };
  }

  const prefixWasUsed =
    approvalState.activeCandidates[input.candidateIdPrefix] !== undefined ||
    approvalState.candidateHistory.some(
      (candidate) => candidate.candidateId === input.candidateIdPrefix,
    );
  const candidateId = prefixWasUsed
    ? `${input.candidateIdPrefix}.${approvalState.nextCandidateSequence.toString(36)}`
    : input.candidateIdPrefix;
  if (
    approvalState.activeCandidates[candidateId] !== undefined ||
    approvalState.candidateHistory.some((candidate) => candidate.candidateId === candidateId)
  ) {
    throw new Error(`Approval candidate id collision: "${candidateId}".`);
  }

  const candidate: ActiveApprovalCandidate = {
    candidateId,
    createdAt: input.createdAt,
    decision: input.decision,
    expiresAt: input.expiresAt,
    requestId: input.requestId,
    responder,
    status: "pending",
  };
  const next: DurableApprovalState = {
    ...approvalState,
    activeCandidates: { ...approvalState.activeCandidates, [candidate.candidateId]: candidate },
    nextCandidateSequence: approvalState.nextCandidateSequence + 1,
  };
  return { changed: true, state: writeApprovalState(expiredState, next) };
}

/** Marks a candidate as waiting on a private authorization challenge. */
export function markApprovalCandidateAuthorizationRequired(input: {
  readonly authorizationChallenges: readonly AuthorizationChallenge[];
  readonly candidateId: string;
  readonly expiresAt?: number;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  const approvalState = readApprovalState(input.state);
  const candidate = approvalState.activeCandidates[input.candidateId];
  if (candidate === undefined) return input.state;
  const nextCandidate: ActiveApprovalCandidate = {
    ...candidate,
    authorizationChallenges: input.authorizationChallenges,
    expiresAt: input.expiresAt ?? candidate.expiresAt,
    status: "authorization-required",
  };
  return writeApprovalState(input.state, {
    ...approvalState,
    activeCandidates: { ...approvalState.activeCandidates, [input.candidateId]: nextCandidate },
  });
}

/** Finishes one candidate without settling the shared request. */
export function finishApprovalCandidate(input: {
  readonly candidateId: string;
  readonly completedAt: number;
  readonly reason?: string;
  readonly state: SessionStateMap | undefined;
  readonly status: Exclude<ApprovalCandidateStatus, "pending" | "authorization-required">;
}): SessionStateMap | undefined {
  const approvalState = readApprovalState(input.state);
  const candidate = approvalState.activeCandidates[input.candidateId];
  if (candidate === undefined) return input.state;
  const activeCandidates = { ...approvalState.activeCandidates };
  delete activeCandidates[input.candidateId];
  return writeApprovalState(input.state, {
    ...approvalState,
    activeCandidates,
    candidateHistory: [
      ...approvalState.candidateHistory,
      toCandidateAuditRecord({
        candidate,
        completedAt: input.completedAt,
        reason: input.reason,
        status: input.status,
      }),
    ],
  });
}

/** Expires active candidates whose deterministic deadline has passed. */
export function expireApprovalCandidates(input: {
  readonly now: number;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  let state = input.state;
  const candidates = Object.values(readApprovalState(state).activeCandidates);
  for (const candidate of candidates) {
    if (candidate.expiresAt > input.now) continue;
    state = finishApprovalCandidate({
      candidateId: candidate.candidateId,
      completedAt: input.now,
      state,
      status: "timed-out",
    });
  }
  return state;
}

/**
 * Atomically settles a request with an allowed candidate's decision; every
 * losing candidate becomes stale.
 */
export function settleAllowedCandidate(input: {
  readonly candidateId: string;
  readonly settledAt: number;
  readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition {
  const expiredState = expireApprovalCandidates({ now: input.settledAt, state: input.state });
  const approvalState = readApprovalState(expiredState);
  const candidate = approvalState.activeCandidates[input.candidateId];
  if (candidate === undefined) {
    const historical = approvalState.candidateHistory.find(
      (entry) => entry.candidateId === input.candidateId,
    );
    const settlement = historical && approvalState.settlements[historical.requestId];
    if (settlement !== undefined) {
      return { changed: false, state: expiredState };
    }
    throw new Error(`Unknown approval candidate "${input.candidateId}".`);
  }
  return settleRequest({
    candidateId: candidate.candidateId,
    outcome: candidate.decision === "cancel" ? "cancelled" : "allowed",
    requestId: candidate.requestId,
    responder: candidate.responder,
    settledAt: input.settledAt,
    state: expiredState,
  });
}

/**
 * Settles a request whose entry is gone, which no response can approve and no call can run: the
 * candidate fails with `reason`, its competitors go stale, and the call is reported unavailable.
 */
export function settleUnavailableCandidate(input: {
  readonly candidateId: string;
  readonly reason: string;
  readonly settledAt: number;
  readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition {
  const state = expireApprovalCandidates({ now: input.settledAt, state: input.state });
  const candidate = readApprovalState(state).activeCandidates[input.candidateId];
  if (candidate === undefined) return { changed: false, state };
  return settleRequest({
    candidateId: candidate.candidateId,
    outcome: "unavailable",
    reason: input.reason,
    requestId: candidate.requestId,
    responder: candidate.responder,
    settledAt: input.settledAt,
    state,
  });
}

/** Atomically settles a direct authenticated approval response. */
export function settleDirectApprovalResponse(input: {
  readonly actor: SessionAuthContext;
  readonly outcome: "allowed" | "cancelled";
  readonly requestId: string;
  readonly settledAt: number;
  readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition {
  const state = expireApprovalCandidates({ now: input.settledAt, state: input.state });
  return settleRequest({
    outcome: input.outcome,
    requestId: input.requestId,
    responder: input.actor,
    settledAt: input.settledAt,
    state,
  });
}

/** Returns one active candidate by id. */
export function getActiveApprovalCandidate(
  state: SessionStateMap | undefined,
  candidateId: string,
): ActiveApprovalCandidate | undefined {
  return readApprovalState(state).activeCandidates[candidateId];
}

/** Returns a copy of the durable candidate/audit state for inspection and replay. */
export function getApprovalAuditState(state: SessionStateMap | undefined): {
  readonly activeCandidates: readonly ActiveApprovalCandidate[];
  readonly candidateHistory: readonly ApprovalCandidateAuditRecord[];
  readonly settlements: readonly ApprovalSettlementAuditRecord[];
} {
  const approvalState = readApprovalState(state);
  return {
    activeCandidates: Object.values(approvalState.activeCandidates),
    candidateHistory: approvalState.candidateHistory,
    settlements: Object.values(approvalState.settlements),
  };
}

function settleRequest(input: {
  readonly candidateId?: string;
  readonly outcome: ApprovalSettlementAuditRecord["outcome"];
  /** Why the settling candidate failed, for an unavailable request. */
  readonly reason?: string;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
  readonly settledAt: number;
  readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition {
  const approvalState = readApprovalState(input.state);
  const existing = approvalState.settlements[input.requestId];
  if (existing !== undefined) {
    return { changed: false, state: input.state };
  }

  const settlement: ApprovalSettlementAuditRecord = {
    actor: projectResponder(input.responder),
    candidateId: input.candidateId,
    outcome: input.outcome,
    requestId: input.requestId,
    settledAt: input.settledAt,
  };
  const activeCandidates: Record<string, ActiveApprovalCandidate> = {};
  const candidateHistory = [...approvalState.candidateHistory];
  for (const candidate of Object.values(approvalState.activeCandidates)) {
    if (candidate.requestId !== input.requestId) {
      activeCandidates[candidate.candidateId] = candidate;
      continue;
    }
    const settling = candidate.candidateId === input.candidateId;
    candidateHistory.push(
      toCandidateAuditRecord({
        candidate,
        completedAt: input.settledAt,
        reason: settling ? input.reason : undefined,
        status: !settling ? "stale" : input.outcome === "unavailable" ? "failed" : "allowed",
      }),
    );
  }
  const next: DurableApprovalState = {
    activeCandidates,
    candidateHistory,
    nextCandidateSequence: approvalState.nextCandidateSequence,
    settlements: { ...approvalState.settlements, [input.requestId]: settlement },
  };
  return { changed: true, state: writeApprovalState(input.state, next) };
}

function toCandidateAuditRecord(input: {
  readonly candidate: ActiveApprovalCandidate;
  readonly completedAt: number;
  readonly reason?: string;
  readonly status: Exclude<ApprovalCandidateStatus, "pending" | "authorization-required">;
}): ApprovalCandidateAuditRecord {
  const {
    authorizationChallenges: _authorizationChallenges,
    responder,
    ...candidate
  } = input.candidate;
  return {
    ...candidate,
    completedAt: input.completedAt,
    responder: projectResponder(responder),
    reason: input.reason,
    status: input.status,
  };
}

function projectResponder(responder: SessionAuthContext): ApprovalResponderIdentity {
  return {
    authenticator: responder.authenticator,
    issuer: responder.issuer,
    principalId: responder.principalId,
    principalType: responder.principalType,
  };
}

export function sameResponder(
  a: Pick<SessionAuthContext, "authenticator" | "issuer" | "principalId" | "principalType">,
  b: Pick<SessionAuthContext, "authenticator" | "issuer" | "principalId" | "principalType">,
): boolean {
  return (
    a.authenticator === b.authenticator &&
    a.issuer === b.issuer &&
    a.principalId === b.principalId &&
    a.principalType === b.principalType
  );
}

/**
 * The held turn moved on, steered or cancelled: the responders still checking one of its
 * approvals stop, their candidates stale.
 */
export function retireActiveCandidates(
  state: SessionStateMap | undefined,
  input: { readonly completedAt: number; readonly reason: string },
): SessionStateMap | undefined {
  let next = state;
  for (const candidate of getApprovalAuditState(next).activeCandidates) {
    next = finishApprovalCandidate({
      candidateId: candidate.candidateId,
      completedAt: input.completedAt,
      reason: input.reason,
      state: next,
      status: "stale",
    });
  }
  return next;
}
