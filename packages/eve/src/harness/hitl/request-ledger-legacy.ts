import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionStateMap } from "#harness/types.js";
import type {
  ClosedAttempt,
  DurableRequest,
  RequestGroup,
  RequestGroupEvent,
  RequestLedger,
  RequestOutcome,
  RequestRecord,
  ResponseAttempt,
} from "#harness/hitl/request-ledger.js";

const LEGACY_BATCHES_KEY = "eve.runtime.pendingInputBatches";
const LEGACY_BATCH_KEY = "eve.runtime.pendingInputBatch";
const LEGACY_APPROVAL_STATE_KEY = "eve.runtime.hitl.approvalState";
const LEGACY_PENDING_AUTHORIZATION_KEY = "eve.runtime.pendingAuthorization";

type LegacyApprovalCandidateStatus =
  | "pending"
  | "authorization-required"
  | "allowed"
  | "rejected"
  | "failed"
  | "timed-out"
  | "stale";

interface LegacyApprovalResponderIdentity {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
}

interface LegacyApprovalCandidateAuditRecord {
  readonly candidateId: string;
  readonly requestId: string;
  readonly responder: LegacyApprovalResponderIdentity;
  readonly status: LegacyApprovalCandidateStatus;
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly deliveryId?: string;
  readonly eventEmitted?: boolean;
  readonly expiresAt?: number;
  readonly reason?: string;
}

interface LegacyApprovalSettlementAuditRecord {
  readonly actor: LegacyApprovalResponderIdentity;
  readonly outcome: "allowed" | "cancelled";
  readonly requestId: string;
  readonly settledAt: number;
  readonly candidateId?: string;
  readonly eventEmitted?: boolean;
}

interface LegacyActiveApprovalResponseAttempt {
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

interface LegacyDurableResponseAttemptState {
  readonly activeResponseAttempts?: Readonly<Record<string, LegacyActiveApprovalResponseAttempt>>;
  readonly responseAttemptHistory?: readonly LegacyApprovalCandidateAuditRecord[];
  readonly settlements?: Readonly<Record<string, LegacyApprovalSettlementAuditRecord>>;
}

export function importLegacyBatches(input: {
  readonly state: SessionStateMap | undefined;
  readonly authorizationRequestId: (entry: {
    readonly challenge: AuthorizationChallenge;
    readonly responseAttemptId?: string;
  }) => string;
  readonly assertUniqueRequestIds: (requests: readonly RequestRecord[]) => void;
}): RequestLedger {
  type LegacyOpenRequestGroup = {
    readonly event?: RequestGroupEvent;
    readonly requests: readonly import("#shared/input.js").InputRequest[];
    readonly responseAuthRequiredRequestIds?: readonly string[];
    readonly responseMessages: readonly ModelMessage[];
  };

  const collection = input.state?.[LEGACY_BATCHES_KEY];
  const candidates = Array.isArray(collection) ? collection : [input.state?.[LEGACY_BATCH_KEY]];
  const groups = candidates.filter((value): value is LegacyOpenRequestGroup => {
    if (typeof value !== "object" || value === null) return false;
    const group = value as LegacyOpenRequestGroup;
    return Array.isArray(group.requests) && Array.isArray(group.responseMessages);
  });
  const requests: RequestRecord[] = [];
  const importedGroups = groups.map((group, index): RequestGroup => {
    const id =
      group.event === undefined
        ? `session-turn:${String(index)}`
        : `session-turn:${group.event.turnId}:${String(group.event.stepIndex)}`;
    requests.push(
      ...group.requests.map((request) => ({
        groupId: id,
        id: request.requestId,
        request,
      })),
    );
    return {
      completion: "waiting",
      event: group.event,
      id,
      owner: "session-turn",
      requestIds: group.requests.map((request) => request.requestId),
      responseAuthRequiredRequestIds: group.responseAuthRequiredRequestIds,
      responseMessages: group.responseMessages,
    };
  });

  const requestsWithAttempts = mergeLegacyApprovalState({
    authorizationRequestId: input.authorizationRequestId,
    authorizationChallenges: readLegacyAuthorizationChallenges({
      authorizationRequestId: input.authorizationRequestId,
      state: input.state,
    }),
    approvalState: readLegacyApprovalState(input.state),
    requests,
  });
  const withPendingAuthorizations = upsertLegacyPendingAuthorizationRequests({
    authorizationRequestId: input.authorizationRequestId,
    authorizations: readLegacyAuthorizations(input.state),
    requests: requestsWithAttempts,
  });

  input.assertUniqueRequestIds(withPendingAuthorizations);
  return { groups: importedGroups, requests: withPendingAuthorizations, version: 0 };
}

export function normalizePersistedLedger(input: {
  readonly persisted: Record<string, unknown>;
  readonly state: SessionStateMap | undefined;
  readonly authorizationRequestId: (entry: {
    readonly challenge: AuthorizationChallenge;
    readonly responseAttemptId?: string;
  }) => string;
}): RequestLedger {
  const groups = Array.isArray(input.persisted.groups)
    ? (input.persisted.groups as readonly RequestGroup[])
    : [];
  const requests = Array.isArray(input.persisted.requests)
    ? (input.persisted.requests as readonly Record<string, unknown>[])
    : [];
  const normalized = requests.map((request) => normalizePersistedRequest(request));
  const mergedApproval = mergeLegacyApprovalState({
    authorizationRequestId: input.authorizationRequestId,
    authorizationChallenges: readLegacyAuthorizationChallenges({
      authorizationRequestId: input.authorizationRequestId,
      state: input.state,
    }),
    approvalState: input.persisted.responseAttempts as
      | LegacyDurableResponseAttemptState
      | undefined,
    requests: normalized,
  });
  const withPendingAuthorizations = upsertLegacyPendingAuthorizationRequests({
    authorizationRequestId: input.authorizationRequestId,
    authorizations: readLegacyAuthorizations(input.state),
    requests: mergedApproval,
  });
  return {
    groups,
    requests: withPendingAuthorizations,
    version: typeof input.persisted.version === "number" ? input.persisted.version : 0,
  };
}

function normalizePersistedRequest(request: Record<string, unknown>): RequestRecord {
  const legacyState = request.state;
  return {
    groupId: typeof request.groupId === "string" ? request.groupId : undefined,
    id: String(request.id),
    request: request.request as DurableRequest,
    attempts: Array.isArray(request.attempts)
      ? (request.attempts as readonly ResponseAttempt[])
      : undefined,
    attemptHistory: Array.isArray(request.attemptHistory)
      ? (request.attemptHistory as readonly ClosedAttempt[])
      : undefined,
    outcome:
      typeof request.outcome === "object" && request.outcome !== null
        ? (request.outcome as RequestOutcome)
        : legacyState === "terminal"
          ? ({ kind: "ignored", at: 0 } satisfies RequestOutcome)
          : undefined,
    outcomeEventEmitted:
      typeof request.outcomeEventEmitted === "boolean" ? request.outcomeEventEmitted : undefined,
  };
}

function mergeLegacyApprovalState(input: {
  readonly requests: readonly RequestRecord[];
  readonly approvalState: LegacyDurableResponseAttemptState | undefined;
  readonly authorizationChallenges: ReadonlyMap<string, readonly AuthorizationChallenge[]>;
  readonly authorizationRequestId: (entry: {
    readonly challenge: AuthorizationChallenge;
    readonly responseAttemptId?: string;
  }) => string;
}): RequestRecord[] {
  if (input.approvalState === undefined) return [...input.requests];

  const attemptsByRequestId = new Map<string, ResponseAttempt[]>();
  for (const attempt of Object.values(input.approvalState.activeResponseAttempts ?? {})) {
    const list = attemptsByRequestId.get(attempt.requestId) ?? [];
    list.push(
      toResponseAttempt({
        attempt,
        authorizationChallenges: input.authorizationChallenges.get(attempt.attemptId) ?? [],
        authorizationRequestId: input.authorizationRequestId,
      }),
    );
    attemptsByRequestId.set(attempt.requestId, list);
  }

  const historyByRequestId = new Map<string, ClosedAttempt[]>();
  for (const attempt of input.approvalState.responseAttemptHistory ?? []) {
    const list = historyByRequestId.get(attempt.requestId) ?? [];
    list.push(toClosedAttempt(attempt));
    historyByRequestId.set(attempt.requestId, list);
  }

  const settlements = input.approvalState.settlements ?? {};
  return input.requests.map((request) => {
    if (!isApprovalRequestRecord(request)) return request;
    const attempts = attemptsByRequestId.get(request.id);
    const attemptHistory = historyByRequestId.get(request.id);
    const settlement = settlements[request.id];
    return {
      ...request,
      attempts: attempts && attempts.length > 0 ? attempts : request.attempts,
      attemptHistory:
        attemptHistory && attemptHistory.length > 0 ? attemptHistory : request.attemptHistory,
      outcome: request.outcome ?? toRequestOutcome(settlement),
      outcomeEventEmitted:
        request.outcomeEventEmitted ??
        (settlement !== undefined ? settlement.eventEmitted : undefined),
    };
  });
}

function upsertLegacyPendingAuthorizationRequests(input: {
  readonly requests: readonly RequestRecord[];
  readonly authorizations: readonly {
    readonly challenge: AuthorizationChallenge;
    readonly responseAttemptId?: string;
  }[];
  readonly authorizationRequestId: (entry: {
    readonly challenge: AuthorizationChallenge;
    readonly responseAttemptId?: string;
  }) => string;
}): RequestRecord[] {
  if (input.authorizations.length === 0) return [...input.requests];
  const desired = new Map(
    input.authorizations.map((entry) => {
      const id = input.authorizationRequestId(entry);
      return [
        id,
        {
          id,
          request: {
            authorization: entry.challenge,
            kind: "authorization" as const,
            requestId: id,
            responseAttemptId: entry.responseAttemptId,
          },
        } satisfies RequestRecord,
      ] as const;
    }),
  );

  const result = input.requests.map((record) => {
    if (record.request.kind !== "authorization") return record;
    const replacement = desired.get(record.id);
    if (replacement === undefined) return record;
    desired.delete(record.id);
    return record.outcome === undefined ? replacement : record;
  });
  return [...result, ...desired.values()];
}

function readLegacyApprovalState(
  state: SessionStateMap | undefined,
): LegacyDurableResponseAttemptState | undefined {
  const legacy = state?.[LEGACY_APPROVAL_STATE_KEY];
  return typeof legacy === "object" && legacy !== null
    ? (legacy as LegacyDurableResponseAttemptState)
    : undefined;
}

function readLegacyAuthorizationChallenges(input: {
  readonly state: SessionStateMap | undefined;
  readonly authorizationRequestId: (entry: {
    readonly challenge: AuthorizationChallenge;
    readonly responseAttemptId?: string;
  }) => string;
}): ReadonlyMap<string, readonly AuthorizationChallenge[]> {
  const pending = readLegacyAuthorizations(input.state);
  const byAttemptId = new Map<string, AuthorizationChallenge[]>();
  for (const entry of pending) {
    const attemptId = entry.responseAttemptId;
    if (attemptId === undefined) continue;
    const list = byAttemptId.get(attemptId) ?? [];
    list.push(entry.challenge);
    byAttemptId.set(attemptId, list);
  }
  return byAttemptId;
}

function readLegacyAuthorizations(
  state: SessionStateMap | undefined,
): readonly { readonly challenge: AuthorizationChallenge; readonly responseAttemptId?: string }[] {
  const legacy = state?.[LEGACY_PENDING_AUTHORIZATION_KEY] as
    | { readonly challenges?: readonly AuthorizationChallenge[] }
    | undefined;
  return (
    legacy?.challenges?.map((challenge) => ({
      challenge,
      responseAttemptId: challenge.candidateId,
    })) ?? []
  );
}

function toResponseAttempt(input: {
  readonly attempt: LegacyActiveApprovalResponseAttempt;
  readonly authorizationChallenges: readonly AuthorizationChallenge[];
  readonly authorizationRequestId: (entry: {
    readonly challenge: AuthorizationChallenge;
    readonly responseAttemptId?: string;
  }) => string;
}): ResponseAttempt {
  return {
    id: input.attempt.attemptId,
    createdAt: input.attempt.createdAt,
    deliveryId: input.attempt.deliveryId,
    expiresAt: input.attempt.expiresAt,
    responder: input.attempt.responder,
    status:
      input.attempt.status === "authorization-required" ? "awaiting-authorization" : "pending",
    authorizationRequestIds: input.authorizationChallenges.map((challenge) =>
      input.authorizationRequestId({ challenge, responseAttemptId: input.attempt.attemptId }),
    ),
  };
}

function toClosedAttempt(attempt: LegacyApprovalCandidateAuditRecord): ClosedAttempt {
  return {
    id: attempt.candidateId,
    createdAt: attempt.createdAt,
    deliveryId: attempt.deliveryId,
    expiresAt: attempt.expiresAt ?? attempt.completedAt ?? attempt.createdAt,
    responder: attempt.responder as SessionAuthContext,
    status: mapLegacyClosedAttemptStatus(attempt.status),
    authorizationRequestIds: [],
    completedAt: attempt.completedAt ?? attempt.createdAt,
    reason: attempt.reason,
    eventEmitted: attempt.eventEmitted,
  };
}

function mapLegacyClosedAttemptStatus(
  status: LegacyApprovalCandidateStatus,
): ClosedAttempt["status"] {
  switch (status) {
    case "allowed":
      return "allowed";
    case "rejected":
      return "rejected";
    case "failed":
      return "failed";
    case "timed-out":
      return "timed-out";
    case "stale":
      return "stale";
    case "pending":
    case "authorization-required":
      return "stale";
  }
}

function toRequestOutcome(
  settlement: LegacyApprovalSettlementAuditRecord | undefined,
): RequestOutcome | undefined {
  if (settlement === undefined) return undefined;
  if (settlement.outcome === "allowed") {
    return {
      kind: "approved",
      actor: settlement.actor,
      attemptId: settlement.candidateId,
      at: settlement.settledAt,
    };
  }
  return { kind: "cancelled", at: settlement.settledAt };
}

function isApprovalRequestRecord(request: RequestRecord): boolean {
  return request.request.kind === "tool-approval";
}
