import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionStateMap } from "#harness/types.js";
import {
  readApprovalAttemptState,
  readPendingAuthorizationState,
  writeApprovalAttemptState,
  writePendingAuthorizationState,
} from "#harness/hitl/request-ledger.js";

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
  readonly deliveryId?: string;
  readonly eventEmitted?: boolean;
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
  readonly outcome: "allowed" | "cancelled";
  readonly requestId: string;
  readonly settledAt: number;
  readonly candidateId?: string;
  readonly eventEmitted?: boolean;
}

export interface ActiveApprovalResponseAttempt {
  readonly attemptId: string;
  readonly candidateId: string;
  readonly createdAt: number;
  readonly deliveryId?: string;
  readonly expiresAt: number;
  readonly pendingEventEmitted?: boolean;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
  readonly status: "pending" | "authorization-required";
}

export interface DurableResponseAttemptState {
  readonly activeResponseAttempts: Readonly<Record<string, ActiveApprovalResponseAttempt>>;
  readonly nextAttemptSequence: number;
  readonly responseAttemptHistory: readonly ApprovalCandidateAuditRecord[];
  readonly settlements: Readonly<Record<string, ApprovalSettlementAuditRecord>>;
}

export interface ApprovalStateTransition {
  readonly changed: boolean;
  readonly state: SessionStateMap | undefined;
}

export function createApprovalCandidate(input: {
  readonly candidateIdPrefix: string;
  readonly createdAt: number;
  readonly deliveryId?: string;
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

  const attemptId = approvalResponseAttemptId({
    deliveryId: input.deliveryId,
    requestId: input.requestId,
    responder: input.responder,
  });
  const duplicate = approvalState.activeResponseAttempts[attemptId];
  if (duplicate !== undefined) {
    return { changed: false, state: expiredState };
  }
  if (approvalState.responseAttemptHistory.some((attempt) => attempt.candidateId === attemptId)) {
    return { changed: false, state: expiredState };
  }

  const prefixWasUsed =
    Object.values(approvalState.activeResponseAttempts).some(
      (attempt) => attempt.candidateId === input.candidateIdPrefix,
    ) ||
    approvalState.responseAttemptHistory.some(
      (attempt) => attempt.candidateId === input.candidateIdPrefix,
    );
  const candidateId = prefixWasUsed
    ? `${input.candidateIdPrefix}.${approvalState.nextAttemptSequence.toString(36)}`
    : input.candidateIdPrefix;
  if (
    Object.values(approvalState.activeResponseAttempts).some(
      (attempt) => attempt.candidateId === candidateId,
    ) ||
    approvalState.responseAttemptHistory.some((attempt) => attempt.candidateId === candidateId)
  ) {
    throw new Error(`Approval response attempt id collision: "${candidateId}".`);
  }

  const attempt: ActiveApprovalResponseAttempt = {
    attemptId,
    candidateId,
    createdAt: input.createdAt,
    deliveryId: input.deliveryId,
    expiresAt: input.expiresAt,
    requestId: input.requestId,
    responder: input.responder,
    status: "pending",
  };
  const next: DurableResponseAttemptState = {
    ...approvalState,
    activeResponseAttempts: { ...approvalState.activeResponseAttempts, [attemptId]: attempt },
    nextAttemptSequence: approvalState.nextAttemptSequence + 1,
  };
  return { changed: true, state: writeApprovalState(expiredState, next) };
}

export function markApprovalCandidatePendingEventEmitted(input: {
  readonly candidateId: string;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  const approvalState = readApprovalState(input.state);
  const attempt = findActiveAttemptByCandidateId(approvalState, input.candidateId);
  if (attempt === undefined || attempt.pendingEventEmitted === true) return input.state;
  return writeApprovalState(input.state, {
    ...approvalState,
    activeResponseAttempts: {
      ...approvalState.activeResponseAttempts,
      [attempt.attemptId]: { ...attempt, pendingEventEmitted: true },
    },
  });
}

export function markApprovalCandidateHistoryEventEmitted(input: {
  readonly candidateId: string;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  const approvalState = readApprovalState(input.state);
  let changed = false;
  const responseAttemptHistory = approvalState.responseAttemptHistory.map((attempt) => {
    if (attempt.candidateId !== input.candidateId || attempt.eventEmitted === true) {
      return attempt;
    }
    changed = true;
    return { ...attempt, eventEmitted: true };
  });
  return changed
    ? writeApprovalState(input.state, { ...approvalState, responseAttemptHistory })
    : input.state;
}

export function markApprovalSettlementEventEmitted(input: {
  readonly requestId: string;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  const approvalState = readApprovalState(input.state);
  const settlement = approvalState.settlements[input.requestId];
  if (settlement === undefined || settlement.eventEmitted === true) return input.state;
  return writeApprovalState(input.state, {
    ...approvalState,
    settlements: {
      ...approvalState.settlements,
      [input.requestId]: { ...settlement, eventEmitted: true },
    },
  });
}

export function markApprovalCandidateAuthorizationRequired(input: {
  readonly authorizationChallenges: readonly AuthorizationChallenge[];
  readonly candidateId: string;
  readonly expiresAt?: number;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  const approvalState = readApprovalState(input.state);
  const attempt = findActiveAttemptByCandidateId(approvalState, input.candidateId);
  if (attempt === undefined) return input.state;
  const nextAttempt: ActiveApprovalResponseAttempt = {
    ...attempt,
    expiresAt: input.expiresAt ?? attempt.expiresAt,
    status: "authorization-required",
  };
  const nextState = writeApprovalState(input.state, {
    ...approvalState,
    activeResponseAttempts: {
      ...approvalState.activeResponseAttempts,
      [attempt.attemptId]: nextAttempt,
    },
  });
  return upsertAttemptAuthorizations(nextState, attempt.attemptId, input.authorizationChallenges);
}

export function finishApprovalCandidate(input: {
  readonly candidateId: string;
  readonly completedAt: number;
  readonly reason?: string;
  readonly state: SessionStateMap | undefined;
  readonly status: Exclude<ApprovalCandidateStatus, "pending" | "authorization-required">;
}): SessionStateMap | undefined {
  const approvalState = readApprovalState(input.state);
  const attempt = findActiveAttemptByCandidateId(approvalState, input.candidateId);
  if (attempt === undefined) return input.state;
  const activeResponseAttempts = { ...approvalState.activeResponseAttempts };
  delete activeResponseAttempts[attempt.attemptId];
  return clearAttemptAuthorizations(
    writeApprovalState(input.state, {
      ...approvalState,
      activeResponseAttempts,
      responseAttemptHistory: [
        ...approvalState.responseAttemptHistory,
        toCandidateAuditRecord({
          attempt,
          completedAt: input.completedAt,
          reason: input.reason,
          status: input.status,
        }),
      ],
    }),
    attempt.attemptId,
  );
}

export function expireApprovalCandidates(input: {
  readonly now: number;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  let state = input.state;
  const attempts = Object.values(readApprovalState(state).activeResponseAttempts);
  for (const attempt of attempts) {
    if (attempt.expiresAt > input.now) continue;
    state = finishApprovalCandidate({
      candidateId: attempt.candidateId,
      completedAt: input.now,
      state,
      status: "timed-out",
    });
  }
  return state;
}

export function settleAllowedCandidate(input: {
  readonly candidateId: string;
  readonly settledAt: number;
  readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition {
  const expiredState = expireApprovalCandidates({ now: input.settledAt, state: input.state });
  const approvalState = readApprovalState(expiredState);
  const attempt = findActiveAttemptByCandidateId(approvalState, input.candidateId);
  if (attempt === undefined) {
    const historical = approvalState.responseAttemptHistory.find(
      (entry) => entry.candidateId === input.candidateId,
    );
    const settlement = historical && approvalState.settlements[historical.requestId];
    if (settlement !== undefined) {
      return { changed: false, state: expiredState };
    }
    throw new Error(`Unknown approval response attempt "${input.candidateId}".`);
  }
  return settleRequest({
    actor: projectResponder(attempt.responder),
    candidateId: attempt.candidateId,
    outcome: "allowed",
    requestId: attempt.requestId,
    settledAt: input.settledAt,
    state: expiredState,
  });
}

export function settleDirectApprovalResponse(input: {
  readonly actor: SessionAuthContext;
  readonly outcome: "allowed" | "cancelled";
  readonly requestId: string;
  readonly settledAt: number;
  readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition {
  const state = expireApprovalCandidates({ now: input.settledAt, state: input.state });
  return settleRequest({
    actor: projectResponder(input.actor),
    outcome: input.outcome,
    requestId: input.requestId,
    settledAt: input.settledAt,
    state,
  });
}

export function getActiveApprovalCandidate(
  state: SessionStateMap | undefined,
  candidateId: string,
): ActiveApprovalResponseAttempt | undefined {
  return findActiveAttemptByCandidateId(readApprovalState(state), candidateId);
}

export function getApprovalAuditState(state: SessionStateMap | undefined): {
  readonly activeCandidates: readonly ActiveApprovalResponseAttempt[];
  readonly candidateHistory: readonly ApprovalCandidateAuditRecord[];
  readonly settlements: readonly ApprovalSettlementAuditRecord[];
} {
  const approvalState = readApprovalState(state);
  return {
    activeCandidates: Object.values(approvalState.activeResponseAttempts),
    candidateHistory: approvalState.responseAttemptHistory,
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
}): ApprovalStateTransition {
  const approvalState = readApprovalState(input.state);
  const existing = approvalState.settlements[input.requestId];
  if (existing !== undefined) {
    return { changed: false, state: input.state };
  }

  const settlement: ApprovalSettlementAuditRecord = {
    actor: input.actor,
    candidateId: input.candidateId,
    outcome: input.outcome,
    requestId: input.requestId,
    settledAt: input.settledAt,
  };
  const activeResponseAttempts: Record<string, ActiveApprovalResponseAttempt> = {};
  const responseAttemptHistory = [...approvalState.responseAttemptHistory];
  const clearedAttemptIds: string[] = [];
  for (const attempt of Object.values(approvalState.activeResponseAttempts)) {
    if (attempt.requestId !== input.requestId) {
      activeResponseAttempts[attempt.attemptId] = attempt;
      continue;
    }
    clearedAttemptIds.push(attempt.attemptId);
    responseAttemptHistory.push(
      toCandidateAuditRecord({
        attempt,
        completedAt: input.settledAt,
        status: attempt.candidateId === input.candidateId ? "allowed" : "stale",
      }),
    );
  }
  const next: DurableResponseAttemptState = {
    activeResponseAttempts,
    responseAttemptHistory,
    nextAttemptSequence: approvalState.nextAttemptSequence,
    settlements: { ...approvalState.settlements, [input.requestId]: settlement },
  };
  return {
    changed: true,
    state: clearAttemptAuthorizations(writeApprovalState(input.state, next), ...clearedAttemptIds),
  };
}

function toCandidateAuditRecord(input: {
  readonly attempt: ActiveApprovalResponseAttempt;
  readonly completedAt: number;
  readonly reason?: string;
  readonly status: Exclude<ApprovalCandidateStatus, "pending" | "authorization-required">;
}): ApprovalCandidateAuditRecord {
  const { responder, ...attempt } = input.attempt;
  return {
    ...attempt,
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

function readApprovalState(state: SessionStateMap | undefined): DurableResponseAttemptState {
  const raw = readApprovalAttemptState(state) as Record<string, unknown> | undefined;
  const migrated = migrateApprovalState(raw);
  return migrated;
}

function writeApprovalState(
  state: SessionStateMap | undefined,
  approvalState: DurableResponseAttemptState,
): SessionStateMap {
  return writeApprovalAttemptState(state, approvalState);
}

function migrateApprovalState(
  raw: Record<string, unknown> | undefined,
): DurableResponseAttemptState {
  const activeResponseAttempts = isRecord(raw?.activeResponseAttempts)
    ? (raw.activeResponseAttempts as Record<string, ActiveApprovalResponseAttempt>)
    : isRecord(raw?.activeCandidates)
      ? Object.fromEntries(
          Object.entries(raw.activeCandidates as Record<string, ActiveApprovalResponseAttempt>).map(
            ([legacyCandidateId, attempt]) => {
              const normalized = {
                ...attempt,
                attemptId: attempt.attemptId ?? legacyCandidateId,
                candidateId: attempt.candidateId ?? legacyCandidateId,
              };
              return [normalized.attemptId, normalized];
            },
          ),
        )
      : {};
  const responseAttemptHistory = Array.isArray(raw?.responseAttemptHistory)
    ? (raw.responseAttemptHistory as ApprovalCandidateAuditRecord[])
    : Array.isArray(raw?.candidateHistory)
      ? (raw.candidateHistory as ApprovalCandidateAuditRecord[])
      : [];
  const nextAttemptSequence =
    typeof raw?.nextAttemptSequence === "number"
      ? raw.nextAttemptSequence
      : typeof raw?.nextCandidateSequence === "number"
        ? raw.nextCandidateSequence
        : 0;
  const settlements = isRecord(raw?.settlements)
    ? (raw.settlements as DurableResponseAttemptState["settlements"])
    : {};
  return {
    activeResponseAttempts,
    nextAttemptSequence,
    responseAttemptHistory,
    settlements,
  };
}

function approvalResponseAttemptId(input: {
  readonly deliveryId?: string;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
}): string {
  if (input.deliveryId !== undefined) {
    return `response-attempt:${JSON.stringify([input.requestId, input.deliveryId])}`;
  }
  return [
    "compat",
    input.requestId,
    input.responder.authenticator,
    input.responder.issuer ?? "",
    input.responder.principalType,
    input.responder.principalId,
  ].join(":");
}

function findActiveAttemptByCandidateId(
  approvalState: DurableResponseAttemptState,
  candidateId: string,
): ActiveApprovalResponseAttempt | undefined {
  return Object.values(approvalState.activeResponseAttempts).find(
    (attempt) => attempt.candidateId === candidateId,
  );
}

function upsertAttemptAuthorizations(
  state: SessionStateMap | undefined,
  responseAttemptId: string,
  challenges: readonly AuthorizationChallenge[],
): SessionStateMap | undefined {
  const previous = readPendingAuthorizationState(state) ?? [];
  const retained = previous.filter((entry) => entry.responseAttemptId !== responseAttemptId);
  return writePendingAuthorizationState(state, [
    ...retained,
    ...challenges.map((challenge) => ({ challenge, responseAttemptId })),
  ]);
}

function clearAttemptAuthorizations(
  state: SessionStateMap | undefined,
  ...responseAttemptIds: string[]
): SessionStateMap | undefined {
  if (responseAttemptIds.length === 0) return state;
  const previous = readPendingAuthorizationState(state) ?? [];
  const blocked = new Set(responseAttemptIds);
  const remaining = previous.filter((entry) => !blocked.has(entry.responseAttemptId ?? ""));
  if (remaining.length === previous.length) return state;
  return remaining.length === 0
    ? writePendingAuthorizationState(state, [])
    : writePendingAuthorizationState(state, remaining);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
