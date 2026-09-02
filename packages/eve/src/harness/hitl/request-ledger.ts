import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type {
  AuthorizationChallenge,
  AuthorizationResult,
  PendingAuthorizationState,
} from "#harness/authorization.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { isInputRequest, type InputRequest, type InputResponse } from "#shared/input.js";

const KEY = "eve.runtime.hitl.requestLedger";
const LEGACY_BATCHES_KEY = "eve.runtime.pendingInputBatches";
const LEGACY_BATCH_KEY = "eve.runtime.pendingInputBatch";
const LEGACY_APPROVAL_STATE_KEY = "eve.runtime.hitl.approvalState";
const LEGACY_PENDING_AUTHORIZATION_KEY = "eve.runtime.pendingAuthorization";

export interface RequestGroupEvent {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

export interface InternalAuthorizationRequest {
  readonly authorization: AuthorizationChallenge;
  readonly kind: "authorization";
  readonly requestId: string;
  readonly responseAttemptId?: string;
}

export type DurableRequest = InputRequest | InternalAuthorizationRequest;

export type ResponderIdentity = Pick<
  SessionAuthContext,
  "authenticator" | "issuer" | "principalId" | "principalType"
>;

export type ResponseAttemptStatus = "pending" | "awaiting-authorization";

export interface ResponseAttempt {
  readonly id: string;
  readonly deliveryId?: string;
  readonly responder: SessionAuthContext;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: ResponseAttemptStatus;
  readonly authorizationRequestIds: readonly string[];
}

export type ClosedAttemptStatus =
  | "allowed"
  | "rejected"
  | "failed"
  | "timed-out"
  | "stale"
  | "cancelled";

export interface ClosedAttempt {
  readonly id: string;
  readonly deliveryId?: string;
  readonly responder: SessionAuthContext;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: ClosedAttemptStatus;
  readonly authorizationRequestIds: readonly string[];
  readonly completedAt: number;
  readonly reason?: string;
  readonly eventEmitted?: boolean;
}

export type RequestOutcome =
  | {
      readonly kind: "approved";
      /** Absent when the response carried no responder identity. */
      readonly actor?: ResponderIdentity;
      readonly attemptId?: string;
      readonly at: number;
    }
  | { readonly kind: "denied"; readonly actor?: ResponderIdentity; readonly at: number }
  | { readonly kind: "answered"; readonly response: InputResponse; readonly at: number }
  | { readonly kind: "ignored"; readonly at: number }
  | { readonly kind: "cancelled"; readonly at: number }
  | { readonly kind: "authorized"; readonly result: AuthorizationResult; readonly at: number }
  | { readonly kind: "expired"; readonly at: number };

export interface RequestRecord {
  readonly groupId?: string;
  readonly id: string;
  readonly request: DurableRequest;
  readonly attempts?: readonly ResponseAttempt[];
  readonly attemptHistory?: readonly ClosedAttempt[];
  readonly outcome?: RequestOutcome;
  readonly outcomeEventEmitted?: boolean;
}

export function isOpenRequest(request: RequestRecord): boolean {
  return request.outcome === undefined;
}

export type RequestGroupOwner = "framework-approval-gate" | "session-turn";

export interface ResolvedInputActionBatch {
  readonly event: RequestGroupEvent;
  readonly results: readonly RuntimeToolResultActionResult[];
}

export type GroupCompletion =
  | {
      readonly owner: "session-turn";
      readonly messages: readonly ModelMessage[];
      readonly limitContinuation?: { readonly granted: boolean };
    }
  | {
      readonly owner: "framework-approval-gate";
      readonly messages: readonly ModelMessage[];
      readonly approvedToolKeys: readonly string[];
      readonly rejectedActions: readonly ResolvedInputActionBatch[];
    };

export interface RequestGroupCompletionReady {
  readonly deliveryKey: string;
  readonly ownerCompletion: GroupCompletion;
  readonly status: "ready";
}

export interface RequestGroupCompletionDelivered {
  readonly deliveryKey: string;
  readonly status: "delivered";
}

export interface RequestGroup {
  readonly completion:
    | "waiting"
    | "cancelled"
    | RequestGroupCompletionReady
    | RequestGroupCompletionDelivered;
  readonly event?: RequestGroupEvent;
  readonly id: string;
  readonly owner: RequestGroupOwner;
  readonly requestIds: readonly string[];
  readonly responseAuthRequiredRequestIds?: readonly string[];
  readonly responseMessages: readonly ModelMessage[];
}

export type OpenRequestGroup = RequestGroup & { readonly requests: readonly InputRequest[] };

export interface ReadyRequestGroupDeliveryTarget {
  readonly groupId: string;
  readonly owner: RequestGroupOwner;
}

export interface ReadyRequestGroupDelivery {
  readonly deliveryKey: string;
  readonly ownerCompletion: GroupCompletion;
  readonly targets: readonly ReadyRequestGroupDeliveryTarget[];
}

export interface RequestLedger {
  readonly groups: readonly RequestGroup[];
  readonly requests: readonly RequestRecord[];
  readonly version: number;
}

export class RequestLedgerConflictError extends Error {
  constructor() {
    super("Request ledger changed before it could be updated.");
    this.name = "RequestLedgerConflictError";
  }
}

export type RequestResponseClass = "open" | "stale" | "invalid";

export function classifyRequestResponse(
  state: SessionStateMap | undefined,
  requestId: string,
): RequestResponseClass {
  const request = readRequestLedger(state).requests.find((candidate) => candidate.id === requestId);
  if (request === undefined) return "invalid";
  return isOpenRequest(request) ? "open" : "stale";
}

export function readRequestLedger(state: SessionStateMap | undefined): RequestLedger {
  const persisted = state?.[KEY];
  if (typeof persisted === "object" && persisted !== null) {
    const ledger = normalizePersistedLedger(persisted as Record<string, unknown>, state);
    assertUniqueRequestIds(ledger.requests);
    return ledger;
  }
  return importLegacyBatches(state);
}

function writeRequestLedger(input: {
  readonly expectedVersion: number;
  readonly groups: readonly RequestGroup[];
  readonly requests: readonly RequestRecord[];
  readonly session: HarnessSession;
}): HarnessSession {
  const current = readRequestLedger(input.session.state);
  if (current.version !== input.expectedVersion) throw new RequestLedgerConflictError();
  assertUniqueRequestIds(input.requests);
  const state = { ...input.session.state };
  delete state[LEGACY_APPROVAL_STATE_KEY];
  delete state[LEGACY_BATCH_KEY];
  delete state[LEGACY_BATCHES_KEY];
  delete state[LEGACY_PENDING_AUTHORIZATION_KEY];
  state[KEY] = {
    groups: input.groups,
    requests: input.requests,
    version: current.version + 1,
  } satisfies RequestLedger;
  return { ...input.session, state };
}

export function commitRequestLedger(
  session: HarnessSession,
  ledger: RequestLedger,
  expectedVersion: number,
): HarnessSession {
  return writeRequestLedger({
    expectedVersion,
    groups: ledger.groups,
    requests: ledger.requests,
    session,
  });
}

export function closeRequestLedger(session: HarnessSession, now: number): HarnessSession {
  const ledger = readRequestLedger(session.state);
  const openGroupIds = new Set(
    ledger.groups
      .filter((group) => group.completion === "waiting" || isReadyCompletion(group.completion))
      .map((group) => group.id),
  );
  let changed = openGroupIds.size > 0;
  const groups = ledger.groups.map((group) => {
    if (!openGroupIds.has(group.id)) return group;
    return { ...group, completion: "cancelled" as const };
  });
  const requests = ledger.requests.map((request) => {
    if (!isOpenRequest(request)) return request;
    changed = true;
    return closeOpenRequest(request, now);
  });
  if (!changed) return session;
  return writeRequestLedger({
    expectedVersion: ledger.version,
    groups,
    requests,
    session,
  });
}

export function getPendingAuthorization(
  state: SessionStateMap | undefined,
): PendingAuthorizationState | undefined {
  const challenges = openAuthorizationRequests(readRequestLedger(state)).map(
    (record) => record.request.authorization,
  );
  return challenges.length === 0 ? undefined : { challenges };
}

export function hasPendingAuthorization(state: SessionStateMap | undefined): boolean {
  return getPendingAuthorization(state) !== undefined;
}

export function openAuthorizationRequests(
  ledger: RequestLedger,
): readonly (RequestRecord & {
  readonly request: InternalAuthorizationRequest;
  readonly outcome?: undefined;
})[] {
  return ledger.requests.filter(
    (
      record,
    ): record is RequestRecord & {
      readonly request: InternalAuthorizationRequest;
      readonly outcome?: undefined;
    } => isOpenRequest(record) && record.request.kind === "authorization",
  );
}

export function createRequests(input: {
  readonly authorizations?: readonly {
    readonly challenge: AuthorizationChallenge;
    readonly responseAttemptId?: string;
  }[];
  readonly event?: RequestGroupEvent;
  readonly owner?: RequestGroupOwner;
  readonly requests: readonly InputRequest[];
  readonly responseAuthRequiredRequestIds?: readonly string[];
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  const ledger = readRequestLedger(input.session.state);
  const groupId =
    input.event === undefined
      ? `session-turn:${String(ledger.groups.length)}`
      : `session-turn:${input.event.turnId}:${String(input.event.stepIndex)}`;

  const durableReplacements = new Map<string, RequestRecord>();
  for (const request of input.requests) {
    durableReplacements.set(request.requestId, {
      groupId,
      id: request.requestId,
      request,
    });
  }
  for (const entry of input.authorizations ?? []) {
    const id = authorizationRequestId({
      challenge: entry.challenge,
      responseAttemptId: entry.responseAttemptId,
    });
    durableReplacements.set(id, {
      id,
      request: {
        authorization: entry.challenge,
        kind: "authorization" as const,
        requestId: id,
        responseAttemptId: entry.responseAttemptId,
      },
    } satisfies RequestRecord);
  }

  const requests = ledger.requests.map((record) => {
    const replacement = durableReplacements.get(record.id);
    if (replacement === undefined) return record;
    if (isOpenRequest(record)) {
      const isSameSessionLimitRequest =
        record.groupId !== undefined &&
        replacement.groupId === groupId &&
        record.request.kind === "session-limit" &&
        replacement.request.kind === "session-limit";
      if (!isSameSessionLimitRequest) {
        throw new TypeError(
          `Internal pending input invariant violated: requestId must be unique across all pending batches: ${JSON.stringify(record.id)}.`,
        );
      }
    }
    durableReplacements.delete(record.id);
    return replacement;
  });

  return writeRequestLedger({
    expectedVersion: ledger.version,
    groups: [
      ...ledger.groups,
      {
        completion: "waiting",
        event: input.event,
        id: groupId,
        owner: input.owner ?? "session-turn",
        requestIds: input.requests.map((request) => request.requestId),
        responseAuthRequiredRequestIds: input.responseAuthRequiredRequestIds,
        responseMessages: input.responseMessages,
      },
    ],
    requests: [...requests, ...durableReplacements.values()],
    session: input.session,
  });
}

export function openRequestGroups(state: SessionStateMap | undefined): readonly OpenRequestGroup[] {
  const ledger = readRequestLedger(state);
  const requests = new Map(ledger.requests.map((request) => [request.id, request]));
  return ledger.groups.flatMap((group) => {
    if (group.completion !== "waiting") return [];
    const open = group.requestIds.flatMap((id) => {
      const record = requests.get(id);
      return record && isOpenRequest(record) && isInputRequest(record.request)
        ? [record.request]
        : [];
    });
    return open.length === 0 ? [] : [{ ...group, requests: open }];
  });
}

export function hasOpenRequests(state: SessionStateMap | undefined): boolean {
  return openRequestGroups(state).length > 0;
}

export function openRequestIds(state: SessionStateMap | undefined): ReadonlySet<string> {
  return new Set(
    openRequestGroups(state).flatMap((group) => group.requests.map((request) => request.requestId)),
  );
}

export function listReadyRequestGroupDeliveries(
  state: SessionStateMap | undefined,
): readonly ReadyRequestGroupDelivery[] {
  const deliveries = new Map<string, ReadyRequestGroupDelivery>();
  for (const group of readRequestLedger(state).groups) {
    if (!isReadyCompletion(group.completion)) continue;
    const existing = deliveries.get(group.completion.deliveryKey);
    if (existing === undefined) {
      deliveries.set(group.completion.deliveryKey, {
        deliveryKey: group.completion.deliveryKey,
        ownerCompletion: group.completion.ownerCompletion,
        targets: [{ groupId: group.id, owner: group.owner }],
      });
      continue;
    }
    deliveries.set(group.completion.deliveryKey, {
      ...existing,
      targets: [...existing.targets, { groupId: group.id, owner: group.owner }],
    });
  }
  return [...deliveries.values()];
}

export function acknowledgeReadyRequestGroupDelivery(input: {
  readonly deliveryKey: string;
  readonly session: HarnessSession;
}): HarnessSession {
  const ledger = readRequestLedger(input.session.state);
  let changed = false;
  const groups = ledger.groups.map((group) => {
    if (
      !isReadyCompletion(group.completion) ||
      group.completion.deliveryKey !== input.deliveryKey
    ) {
      return group;
    }
    changed = true;
    return {
      ...group,
      completion: { deliveryKey: group.completion.deliveryKey, status: "delivered" as const },
    };
  });
  if (!changed) return input.session;
  return writeRequestLedger({
    expectedVersion: ledger.version,
    groups,
    requests: ledger.requests,
    session: input.session,
  });
}

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

function importLegacyBatches(state: SessionStateMap | undefined): RequestLedger {
  type LegacyOpenRequestGroup = {
    readonly event?: RequestGroupEvent;
    readonly requests: readonly InputRequest[];
    readonly responseAuthRequiredRequestIds?: readonly string[];
    readonly responseMessages: readonly ModelMessage[];
  };

  const collection = state?.[LEGACY_BATCHES_KEY];
  const candidates = Array.isArray(collection) ? collection : [state?.[LEGACY_BATCH_KEY]];
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

  const requestsWithAttempts = mergeLegacyApprovalState(
    requests,
    readLegacyApprovalState(state),
    readLegacyAuthorizationChallenges(state),
  );
  const withPendingAuthorizations = upsertLegacyPendingAuthorizationRequests(
    requestsWithAttempts,
    readLegacyAuthorizations(state),
  );

  assertUniqueRequestIds(withPendingAuthorizations);
  return { groups: importedGroups, requests: withPendingAuthorizations, version: 0 };
}

function normalizePersistedLedger(
  persisted: Record<string, unknown>,
  state: SessionStateMap | undefined,
): RequestLedger {
  const groups = Array.isArray(persisted.groups)
    ? (persisted.groups as readonly RequestGroup[])
    : [];
  const requests = Array.isArray(persisted.requests)
    ? (persisted.requests as readonly Record<string, unknown>[])
    : [];
  const normalized = requests.map((request) => normalizePersistedRequest(request));
  const mergedApproval = mergeLegacyApprovalState(
    normalized,
    persisted.responseAttempts as LegacyDurableResponseAttemptState | undefined,
    readLegacyAuthorizationChallenges(state),
  );
  const withPendingAuthorizations = upsertLegacyPendingAuthorizationRequests(
    mergedApproval,
    readLegacyAuthorizations(state),
  );
  return {
    groups,
    requests: withPendingAuthorizations,
    version: typeof persisted.version === "number" ? persisted.version : 0,
  };
}

function normalizePersistedRequest(request: Record<string, unknown>): RequestRecord {
  const legacyState = request.state;
  const normalized: RequestRecord = {
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
  return normalized;
}

function mergeLegacyApprovalState(
  requests: readonly RequestRecord[],
  approvalState: LegacyDurableResponseAttemptState | undefined,
  authorizationChallenges: ReadonlyMap<string, readonly AuthorizationChallenge[]>,
): RequestRecord[] {
  if (approvalState === undefined) return [...requests];

  const attemptsByRequestId = new Map<string, ResponseAttempt[]>();
  for (const attempt of Object.values(approvalState.activeResponseAttempts ?? {})) {
    const list = attemptsByRequestId.get(attempt.requestId) ?? [];
    list.push(toResponseAttempt(attempt, authorizationChallenges.get(attempt.attemptId) ?? []));
    attemptsByRequestId.set(attempt.requestId, list);
  }

  const historyByRequestId = new Map<string, ClosedAttempt[]>();
  for (const attempt of approvalState.responseAttemptHistory ?? []) {
    const list = historyByRequestId.get(attempt.requestId) ?? [];
    list.push(toClosedAttempt(attempt));
    historyByRequestId.set(attempt.requestId, list);
  }

  const settlements = approvalState.settlements ?? {};
  return requests.map((request) => {
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

function upsertLegacyPendingAuthorizationRequests(
  requests: readonly RequestRecord[],
  authorizations: readonly {
    readonly challenge: AuthorizationChallenge;
    readonly responseAttemptId?: string;
  }[],
): RequestRecord[] {
  if (authorizations.length === 0) return [...requests];
  const desired = new Map(
    authorizations.map((entry) => {
      const id = authorizationRequestId(entry);
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

  const result = requests.map((record) => {
    if (record.request.kind !== "authorization") return record;
    const replacement = desired.get(record.id);
    if (replacement === undefined) return record;
    desired.delete(record.id);
    return isOpenRequest(record) ? replacement : record;
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

function readLegacyAuthorizationChallenges(
  state: SessionStateMap | undefined,
): ReadonlyMap<string, readonly AuthorizationChallenge[]> {
  const pending = readLegacyAuthorizations(state);
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

function toResponseAttempt(
  attempt: LegacyActiveApprovalResponseAttempt,
  challenges: readonly AuthorizationChallenge[],
): ResponseAttempt {
  return {
    id: attempt.attemptId,
    createdAt: attempt.createdAt,
    deliveryId: attempt.deliveryId,
    expiresAt: attempt.expiresAt,
    responder: attempt.responder,
    status: attempt.status === "authorization-required" ? "awaiting-authorization" : "pending",
    authorizationRequestIds: challenges.map((challenge) =>
      authorizationRequestId({ challenge, responseAttemptId: attempt.attemptId }),
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

function mapLegacyClosedAttemptStatus(status: LegacyApprovalCandidateStatus): ClosedAttemptStatus {
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

function closeOpenRequest(request: RequestRecord, now: number): RequestRecord {
  if (request.request.kind === "authorization") {
    return { ...request, outcome: { kind: "cancelled", at: now } };
  }
  const attempts = request.attempts ?? [];
  return {
    ...request,
    attempts: attempts.length === 0 ? undefined : [],
    attemptHistory:
      attempts.length === 0
        ? request.attemptHistory
        : [
            ...(request.attemptHistory ?? []),
            ...attempts.map((attempt): ClosedAttempt => ({
              ...attempt,
              status: "cancelled",
              completedAt: now,
              reason: "The waiting request was cancelled.",
            })),
          ],
    outcome: { kind: "cancelled", at: now },
  };
}

function isApprovalRequestRecord(request: RequestRecord): boolean {
  return request.request.kind === "tool-approval";
}

function isReadyCompletion(
  completion: RequestGroup["completion"],
): completion is RequestGroupCompletionReady {
  return typeof completion === "object" && completion.status === "ready";
}

export function authorizationRequestId(entry: {
  readonly challenge: AuthorizationChallenge;
  readonly responseAttemptId?: string;
}): string {
  return `authorization:${JSON.stringify([
    entry.responseAttemptId ?? null,
    entry.challenge.attemptId ?? entry.challenge.name,
  ])}`;
}

function assertUniqueRequestIds(requests: readonly RequestRecord[]): void {
  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.id)) {
      throw new TypeError(
        `Internal pending input invariant violated: requestId must be unique across all pending batches: ${JSON.stringify(request.id)}.`,
      );
    }
    seen.add(request.id);
  }
}
