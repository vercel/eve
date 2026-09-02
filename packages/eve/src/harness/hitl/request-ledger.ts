import type { ModelMessage } from "ai";

import type { PendingInputBatch, PendingInputBatchEvent } from "#harness/pending-input-batches.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { DurableResponseAttemptState } from "#harness/hitl/approval-response-attempts.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { isInputRequest, type InputRequest } from "#shared/input.js";

const KEY = "eve.runtime.hitl.requestLedger";
const LEGACY_BATCHES_KEY = "eve.runtime.pendingInputBatches";
const LEGACY_BATCH_KEY = "eve.runtime.pendingInputBatch";
const LEGACY_APPROVAL_STATE_KEY = "eve.runtime.hitl.approvalState";
const LEGACY_PENDING_AUTHORIZATION_KEY = "eve.runtime.pendingAuthorization";

export interface InternalAuthorizationRequest {
  readonly authorization: AuthorizationChallenge;
  readonly kind: "authorization";
  readonly requestId: string;
  readonly responseAttemptId?: string;
}

export type DurableRequest = InputRequest | InternalAuthorizationRequest;

export interface RequestRecord {
  readonly groupId?: string;
  readonly id: string;
  readonly request: DurableRequest;
  readonly state: "open" | "terminal";
}

export type RequestGroupOwner = "framework-approval-gate" | "session-turn";

export interface RequestGroupCompletionReady {
  readonly deliveryKey: string;
  readonly ownerCompletion: unknown;
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
  readonly event?: PendingInputBatchEvent;
  readonly id: string;
  readonly owner: RequestGroupOwner;
  readonly requestIds: readonly string[];
  readonly responseAuthRequiredRequestIds?: readonly string[];
  readonly responseMessages: readonly ModelMessage[];
}

export interface ReadyRequestGroupDeliveryTarget {
  readonly groupId: string;
  readonly owner: RequestGroupOwner;
}

export interface ReadyRequestGroupDelivery {
  readonly deliveryKey: string;
  readonly ownerCompletion: unknown;
  readonly targets: readonly ReadyRequestGroupDeliveryTarget[];
}

export interface RequestLedgerAuthorizationRecord {
  readonly challenge: AuthorizationChallenge;
  readonly responseAttemptId?: string;
}

export interface RequestLedger {
  readonly groups: readonly RequestGroup[];
  readonly requests: readonly RequestRecord[];
  readonly responseAttempts?: DurableResponseAttemptState;
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
  return request.state === "open" ? "open" : "stale";
}

export function readRequestLedger(state: SessionStateMap | undefined): RequestLedger {
  const persisted = state?.[KEY] as RequestLedger | undefined;
  if (persisted !== undefined) {
    assertUniqueRequestIds(persisted.requests);
    return persisted;
  }
  return importLegacyBatches(state);
}

export function writeRequestLedger(input: {
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
    ...current,
    groups: input.groups,
    requests: input.requests,
    version: current.version + 1,
  } satisfies RequestLedger;
  return { ...input.session, state };
}

export function readApprovalAttemptState(
  state: SessionStateMap | undefined,
): DurableResponseAttemptState | Record<string, unknown> | undefined {
  const ledger = state?.[KEY] as RequestLedger | undefined;
  if (ledger?.responseAttempts !== undefined) return ledger.responseAttempts;
  const legacy = state?.[LEGACY_APPROVAL_STATE_KEY];
  return typeof legacy === "object" && legacy !== null
    ? (legacy as Record<string, unknown>)
    : undefined;
}

export function writeApprovalAttemptState(
  state: SessionStateMap | undefined,
  responseAttempts: DurableResponseAttemptState,
): SessionStateMap {
  return writeLedgerExtension(state, { responseAttempts }, [LEGACY_APPROVAL_STATE_KEY]);
}

export function readPendingAuthorizationState(
  state: SessionStateMap | undefined,
): readonly RequestLedgerAuthorizationRecord[] | undefined {
  const persisted = state?.[KEY] as
    | (RequestLedger & { readonly authorizations?: readonly RequestLedgerAuthorizationRecord[] })
    | undefined;
  const requests = persisted?.requests
    .filter(
      (record): record is RequestRecord & { readonly request: InternalAuthorizationRequest } =>
        record.state === "open" && record.request.kind === "authorization",
    )
    .map((record) => ({
      challenge: record.request.authorization,
      responseAttemptId: record.request.responseAttemptId,
    }));
  if ((requests?.length ?? 0) > 0) return requests;
  if (Array.isArray(persisted?.authorizations) && persisted.authorizations.length > 0) {
    return persisted.authorizations;
  }
  return readLegacyAuthorizations(state);
}

export function writePendingAuthorizationState(
  state: SessionStateMap | undefined,
  authorizations: readonly RequestLedgerAuthorizationRecord[],
): SessionStateMap {
  const ledger = readRequestLedger(state);
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
          state: "open" as const,
        } satisfies RequestRecord,
      ] as const;
    }),
  );
  const requests = ledger.requests.map((record) => {
    if (record.request.kind !== "authorization") return record;
    const replacement = desired.get(record.id);
    if (replacement !== undefined) {
      desired.delete(record.id);
      return replacement;
    }
    return record.state === "terminal" ? record : { ...record, state: "terminal" as const };
  });
  const result: Record<string, unknown> = {
    ...state,
    [KEY]: {
      ...ledger,
      requests: [...requests, ...desired.values()],
      version: ledger.version + 1,
    } satisfies RequestLedger,
  };
  delete result[LEGACY_PENDING_AUTHORIZATION_KEY];
  const persisted = result[KEY] as Record<string, unknown>;
  delete persisted.authorizations;
  return result;
}

export function clearPendingAuthorizationState(
  state: SessionStateMap | undefined,
): SessionStateMap | undefined {
  if (readPendingAuthorizationState(state) === undefined) return state;
  return writePendingAuthorizationState(state, []);
}

export function createRequestGroup(input: {
  readonly event?: PendingInputBatchEvent;
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
    requests: [
      ...ledger.requests,
      ...input.requests.map((request): RequestRecord => ({
        groupId,
        id: request.requestId,
        request,
        state: "open",
      })),
    ],
    session: input.session,
  });
}

export function openRequestGroups(
  state: SessionStateMap | undefined,
): readonly PendingInputBatch[] {
  const ledger = readRequestLedger(state);
  const requests = new Map(ledger.requests.map((request) => [request.id, request]));
  return ledger.groups.flatMap((group) => {
    if (group.completion !== "waiting") return [];
    const open = group.requestIds.flatMap((id) => {
      const record = requests.get(id);
      return record?.state === "open" && isInputRequest(record.request) ? [record.request] : [];
    });
    return open.length === 0
      ? []
      : [
          {
            event: group.event,
            requests: open,
            responseAuthRequiredRequestIds: group.responseAuthRequiredRequestIds,
            responseMessages: group.responseMessages,
          },
        ];
  });
}

export function prepareReadyRequestGroupDeliveries(input: {
  readonly ownerCompletions: ReadonlyMap<
    string,
    {
      readonly deliveryKey: string;
      readonly ownerCompletion: unknown;
    }
  >;
  readonly session: HarnessSession;
}): HarnessSession {
  const ledger = readRequestLedger(input.session.state);
  if (input.ownerCompletions.size === 0) return input.session;
  const readyGroupIds = new Set(input.ownerCompletions.keys());
  let changed = false;
  const groups = ledger.groups.map((group) => {
    const ready = input.ownerCompletions.get(group.id);
    if (ready === undefined || group.completion !== "waiting") return group;
    changed = true;
    return {
      ...group,
      completion: {
        deliveryKey: ready.deliveryKey,
        ownerCompletion: ready.ownerCompletion,
        status: "ready",
      },
    } satisfies RequestGroup;
  });
  if (!changed) return input.session;
  const requests = ledger.requests.map((request) =>
    request.groupId !== undefined && readyGroupIds.has(request.groupId) && request.state === "open"
      ? { ...request, state: "terminal" as const }
      : request,
  );
  return writeRequestLedger({
    expectedVersion: ledger.version,
    groups,
    requests,
    session: input.session,
  });
}

export function listReadyRequestGroupDeliveries(
  state: SessionStateMap | undefined,
): readonly ReadyRequestGroupDelivery[] {
  const deliveries = new Map<string, ReadyRequestGroupDelivery>();
  for (const group of readRequestLedger(state).groups) {
    if (typeof group.completion !== "object" || group.completion.status !== "ready") continue;
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
      typeof group.completion !== "object" ||
      group.completion.status !== "ready" ||
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

export function cancelIncompleteRequestGroups(session: HarnessSession): HarnessSession {
  const ledger = readRequestLedger(session.state);
  const groupIds = new Set(
    ledger.groups
      .filter((group) => group.completion === "waiting" || typeof group.completion === "object")
      .map((group) => group.id),
  );
  const hasOpenAuthorization = ledger.requests.some(
    (request) => request.state === "open" && request.request.kind === "authorization",
  );
  if (groupIds.size === 0 && !hasOpenAuthorization) return session;
  return writeRequestLedger({
    expectedVersion: ledger.version,
    groups: ledger.groups.map((group) =>
      groupIds.has(group.id) ? { ...group, completion: "cancelled" as const } : group,
    ),
    requests: ledger.requests.map((request) =>
      request.state === "open" &&
      (groupIds.has(request.groupId ?? "") || request.request.kind === "authorization")
        ? { ...request, state: "terminal" as const }
        : request,
    ),
    session,
  });
}

export function completeRequestGroups(
  session: HarnessSession,
  batches: readonly PendingInputBatch[],
): HarnessSession {
  const ledger = readRequestLedger(session.state);
  const ids = new Set(
    batches.flatMap((batch) => batch.requests.map((request) => request.requestId)),
  );
  const groupIds = new Set(
    ledger.groups
      .filter((group) => group.requestIds.some((id) => ids.has(id)))
      .map((group) => group.id),
  );
  if (groupIds.size === 0) return session;
  return writeRequestLedger({
    expectedVersion: ledger.version,
    groups: ledger.groups.map((group) =>
      groupIds.has(group.id)
        ? {
            ...group,
            completion: { deliveryKey: `legacy:${group.id}`, status: "delivered" as const },
          }
        : group,
    ),
    requests: ledger.requests.map((request) =>
      request.groupId !== undefined && groupIds.has(request.groupId)
        ? { ...request, state: "terminal" }
        : request,
    ),
    session,
  });
}

function importLegacyBatches(state: SessionStateMap | undefined): RequestLedger {
  const collection = state?.[LEGACY_BATCHES_KEY];
  const candidates = Array.isArray(collection) ? collection : [state?.[LEGACY_BATCH_KEY]];
  const batches = candidates.filter((value): value is PendingInputBatch => {
    if (typeof value !== "object" || value === null) return false;
    const batch = value as PendingInputBatch;
    return Array.isArray(batch.requests) && Array.isArray(batch.responseMessages);
  });
  const requests: RequestRecord[] = [];
  const groups = batches.map((batch, index): RequestGroup => {
    const id =
      batch.event === undefined
        ? `session-turn:${String(index)}`
        : `session-turn:${batch.event.turnId}:${String(batch.event.stepIndex)}`;
    requests.push(
      ...batch.requests.map((request) => ({
        groupId: id,
        id: request.requestId,
        request,
        state: "open" as const,
      })),
    );
    return {
      completion: "waiting",
      event: batch.event,
      id,
      owner: "session-turn",
      requestIds: batch.requests.map((request) => request.requestId),
      responseAuthRequiredRequestIds: batch.responseAuthRequiredRequestIds,
      responseMessages: batch.responseMessages,
    };
  });
  const authorizations = readLegacyAuthorizations(state) ?? [];
  requests.push(
    ...authorizations.map((entry): RequestRecord => {
      const id = authorizationRequestId(entry);
      return {
        id,
        request: {
          authorization: entry.challenge,
          kind: "authorization",
          requestId: id,
          responseAttemptId: entry.responseAttemptId,
        },
        state: "open",
      };
    }),
  );
  assertUniqueRequestIds(requests);
  return { groups, requests, responseAttempts: undefined, version: 0 };
}

function writeLedgerExtension(
  state: SessionStateMap | undefined,
  extension: Pick<RequestLedger, "responseAttempts">,
  legacyKeys: readonly string[],
): SessionStateMap {
  const ledger = readRequestLedger(state);
  const result: Record<string, unknown> = {
    ...state,
    [KEY]: { ...ledger, ...extension, version: ledger.version + 1 },
  };
  for (const key of legacyKeys) delete result[key];
  return result;
}

function readLegacyAuthorizations(
  state: SessionStateMap | undefined,
): readonly RequestLedgerAuthorizationRecord[] | undefined {
  const legacy = state?.[LEGACY_PENDING_AUTHORIZATION_KEY] as
    | { readonly challenges?: readonly AuthorizationChallenge[] }
    | undefined;
  return legacy?.challenges?.map((challenge) => ({
    challenge,
    responseAttemptId: challenge.candidateId,
  }));
}

function authorizationRequestId(entry: RequestLedgerAuthorizationRecord): string {
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
