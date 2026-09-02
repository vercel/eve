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
import {
  importLegacyBatches,
  normalizePersistedLedger,
} from "#harness/hitl/request-ledger-legacy.js";

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
    const ledger = normalizePersistedLedger({
      authorizationRequestId,
      persisted: persisted as Record<string, unknown>,
      state,
    });
    assertUniqueRequestIds(ledger.requests);
    return ledger;
  }
  return importLegacyBatches({ state, authorizationRequestId, assertUniqueRequestIds });
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

export function openAuthorizationRequests(ledger: RequestLedger): readonly (RequestRecord & {
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

  // Internal Authorization requests are ungrouped; only InputRequests open a Group.
  const groups =
    input.requests.length === 0
      ? ledger.groups
      : [
          ...ledger.groups,
          {
            completion: "waiting" as const,
            event: input.event,
            id: groupId,
            owner: input.owner ?? defaultGroupOwner(input.requests),
            requestIds: input.requests.map((request) => request.requestId),
            responseAuthRequiredRequestIds: input.responseAuthRequiredRequestIds,
            responseMessages: input.responseMessages,
          },
        ];
  return writeRequestLedger({
    expectedVersion: ledger.version,
    groups,
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

/**
 * An Approval in a Group means the framework approval gate is what waits on
 * it; every other Group resumes the session turn.
 */
function defaultGroupOwner(requests: readonly InputRequest[]): RequestGroupOwner {
  return requests.some((request) => request.kind === "tool-approval")
    ? "framework-approval-gate"
    : "session-turn";
}
