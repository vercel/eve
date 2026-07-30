import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionStateMap } from "#harness/types.js";

const APPROVAL_STATE_KEY = "eve.runtime.hitl.approvalState";

export type ApprovalCandidateStatus =
  | "pending"
  | "authorization-required"
  | "allowed"
  | "rejected"
  | "failed"
  | "timed-out"
  | "stale";

export interface ApprovalCandidateAuditRecord {
  readonly candidateId: string;
  readonly requestId: string;
  readonly responder: ApprovalResponderIdentity;
  readonly status: ApprovalCandidateStatus;
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly expiresAt?: number;
  readonly authorizationChallenges?: readonly AuthorizationChallenge[];
  readonly provider?: string;
  readonly runtimeRevision?: string;
  readonly safeReason?: string;
}

export interface ApprovalResponderIdentity {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
}

export interface ApprovalSettlementAuditRecord {
  readonly actor: ApprovalResponderIdentity;
  readonly outcome: "allowed" | "cancelled";
  readonly requestId: string;
  readonly settledAt: number;
  readonly candidateId?: string;
}

export interface ActiveApprovalCandidate {
  readonly candidateId: string;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
  readonly status: "pending" | "authorization-required";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly authorizationChallenges?: readonly AuthorizationChallenge[];
  readonly provider?: string;
  readonly runtimeRevision?: string;
}

interface DurableApprovalState {
  readonly activeCandidates: Readonly<Record<string, ActiveApprovalCandidate>>;
  readonly nextCandidateSequence: number;
  readonly candidateHistory: readonly ApprovalCandidateAuditRecord[];
  readonly settlements: Readonly<Record<string, ApprovalSettlementAuditRecord>>;
}

export type CreateApprovalCandidateResult =
  | { readonly kind: "created"; readonly candidate: ActiveApprovalCandidate }
  | { readonly kind: "duplicate"; readonly candidate: ActiveApprovalCandidate }
  | { readonly kind: "stale"; readonly settlement: ApprovalSettlementAuditRecord };

export type SettleApprovalResult =
  | { readonly kind: "settled"; readonly settlement: ApprovalSettlementAuditRecord }
  | { readonly kind: "stale"; readonly settlement: ApprovalSettlementAuditRecord };

export interface ApprovalStateTransition<TResult> {
  readonly result: TResult;
  readonly state: SessionStateMap | undefined;
}

/** Creates or deduplicates one responder's Allow candidate for a pending request. */
export function createApprovalCandidate(input: {
  readonly candidateIdPrefix: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
  readonly runtimeRevision?: string;
  readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition<CreateApprovalCandidateResult> {
  const expiredState = expireApprovalCandidates({ now: input.createdAt, state: input.state });
  const approvalState = readApprovalState(expiredState);
  const settlement = approvalState.settlements[input.requestId];
  if (settlement !== undefined) {
    return { result: { kind: "stale", settlement }, state: expiredState };
  }

  const responder = input.responder;
  const duplicate = Object.values(approvalState.activeCandidates).find(
    (candidate) =>
      candidate.requestId === input.requestId && sameResponder(candidate.responder, responder),
  );
  if (duplicate !== undefined) {
    return { result: { kind: "duplicate", candidate: duplicate }, state: expiredState };
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
    expiresAt: input.expiresAt,
    requestId: input.requestId,
    responder,
    runtimeRevision: input.runtimeRevision,
    status: "pending",
  };
  const next: DurableApprovalState = {
    ...approvalState,
    activeCandidates: { ...approvalState.activeCandidates, [candidate.candidateId]: candidate },
    nextCandidateSequence: approvalState.nextCandidateSequence + 1,
  };
  return {
    result: { candidate, kind: "created" },
    state: writeApprovalState(expiredState, next),
  };
}

/** Marks a candidate as waiting on a private authorization challenge. */
export function markApprovalCandidateAuthorizationRequired(input: {
  readonly authorizationChallenges: readonly AuthorizationChallenge[];
  readonly candidateId: string;
  readonly expiresAt?: number;
  readonly provider?: string;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  const approvalState = readApprovalState(input.state);
  const candidate = approvalState.activeCandidates[input.candidateId];
  if (candidate === undefined) return input.state;
  const nextCandidate: ActiveApprovalCandidate = {
    ...candidate,
    authorizationChallenges: input.authorizationChallenges,
    expiresAt: input.expiresAt ?? candidate.expiresAt,
    provider: input.provider,
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
  readonly safeReason?: string;
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
        safeReason: input.safeReason,
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

/** Atomically settles an allowed candidate; every losing candidate becomes stale. */
export function settleAllowedCandidate(input: {
  readonly candidateId: string;
  readonly settledAt: number;
  readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition<SettleApprovalResult> {
  const expiredState = expireApprovalCandidates({ now: input.settledAt, state: input.state });
  const approvalState = readApprovalState(expiredState);
  const candidate = approvalState.activeCandidates[input.candidateId];
  if (candidate === undefined) {
    const historical = approvalState.candidateHistory.find(
      (entry) => entry.candidateId === input.candidateId,
    );
    const settlement = historical && approvalState.settlements[historical.requestId];
    if (settlement !== undefined) {
      return { result: { kind: "stale", settlement }, state: expiredState };
    }
    throw new Error(`Unknown approval candidate "${input.candidateId}".`);
  }
  return settleRequest({
    actor: projectResponder(candidate.responder),
    candidateId: candidate.candidateId,
    outcome: "allowed",
    requestId: candidate.requestId,
    settledAt: input.settledAt,
    state: expiredState,
  });
}

/** Atomically settles a direct authenticated approval response. */
export function settleDirectApprovalResponse(input: {
  readonly actor: SessionAuthContext;
  readonly outcome: "allowed" | "cancelled";
  readonly requestId: string;
  readonly settledAt: number;
  readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition<SettleApprovalResult> {
  const state = expireApprovalCandidates({ now: input.settledAt, state: input.state });
  return settleRequest({
    actor: projectResponder(input.actor),
    outcome: input.outcome,
    requestId: input.requestId,
    settledAt: input.settledAt,
    state,
  });
}

/** Atomically cancels a pending request using ordinary authenticated flow control. */
export function cancelApprovalRequest(
  input: Omit<Parameters<typeof settleDirectApprovalResponse>[0], "outcome">,
): ApprovalStateTransition<SettleApprovalResult> {
  return settleDirectApprovalResponse({ ...input, outcome: "cancelled" });
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
  readonly actor: ApprovalResponderIdentity;
  readonly candidateId?: string;
  readonly outcome: ApprovalSettlementAuditRecord["outcome"];
  readonly requestId: string;
  readonly settledAt: number;
  readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition<SettleApprovalResult> {
  const approvalState = readApprovalState(input.state);
  const existing = approvalState.settlements[input.requestId];
  if (existing !== undefined) {
    return { result: { kind: "stale", settlement: existing }, state: input.state };
  }

  const settlement: ApprovalSettlementAuditRecord = {
    actor: input.actor,
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
    candidateHistory.push(
      toCandidateAuditRecord({
        candidate,
        completedAt: input.settledAt,
        status: candidate.candidateId === input.candidateId ? "allowed" : "stale",
      }),
    );
  }
  const next: DurableApprovalState = {
    activeCandidates,
    candidateHistory,
    nextCandidateSequence: approvalState.nextCandidateSequence,
    settlements: { ...approvalState.settlements, [input.requestId]: settlement },
  };
  return {
    result: { kind: "settled", settlement },
    state: writeApprovalState(input.state, next),
  };
}

function toCandidateAuditRecord(input: {
  readonly candidate: ActiveApprovalCandidate;
  readonly completedAt: number;
  readonly safeReason?: string;
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
    safeReason: input.safeReason,
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

function sameResponder(
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

function readApprovalState(state: SessionStateMap | undefined): DurableApprovalState {
  const value = state?.[APPROVAL_STATE_KEY];
  if (typeof value !== "object" || value === null) {
    return {
      activeCandidates: {},
      candidateHistory: [],
      nextCandidateSequence: 0,
      settlements: {},
    };
  }
  const candidate = value as Partial<DurableApprovalState>;
  return {
    activeCandidates:
      typeof candidate.activeCandidates === "object" && candidate.activeCandidates !== null
        ? candidate.activeCandidates
        : {},
    candidateHistory: Array.isArray(candidate.candidateHistory) ? candidate.candidateHistory : [],
    nextCandidateSequence:
      typeof candidate.nextCandidateSequence === "number" &&
      Number.isSafeInteger(candidate.nextCandidateSequence) &&
      candidate.nextCandidateSequence >= 0
        ? candidate.nextCandidateSequence
        : deriveNextCandidateSequence(candidate),
    settlements:
      typeof candidate.settlements === "object" && candidate.settlements !== null
        ? candidate.settlements
        : {},
  };
}

function deriveNextCandidateSequence(state: Partial<DurableApprovalState>): number {
  return (
    Object.keys(state.activeCandidates ?? {}).length +
    (Array.isArray(state.candidateHistory) ? state.candidateHistory.length : 0)
  );
}

function writeApprovalState(
  state: SessionStateMap | undefined,
  approvalState: DurableApprovalState,
): SessionStateMap {
  return { ...state, [APPROVAL_STATE_KEY]: approvalState };
}
