import type { ModelMessage } from "ai";

import type { PendingInputBatch, PendingInputBatchEvent } from "#harness/pending-input-batches.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

const KEY = "eve.runtime.hitl.requestLedger";
const LEGACY_BATCHES_KEY = "eve.runtime.pendingInputBatches";
const LEGACY_BATCH_KEY = "eve.runtime.pendingInputBatch";

export interface RequestRecord {
  readonly groupId: string;
  readonly id: string;
  readonly request: InputRequest;
  readonly state: "open" | "terminal";
}

export interface RequestGroup {
  readonly completion: "waiting" | "delivered" | "cancelled";
  readonly event?: PendingInputBatchEvent;
  readonly id: string;
  readonly owner: "session-turn";
  readonly requestIds: readonly string[];
  readonly responseAuthRequiredRequestIds?: readonly string[];
  readonly responseMessages: readonly ModelMessage[];
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
  delete state[LEGACY_BATCH_KEY];
  delete state[LEGACY_BATCHES_KEY];
  state[KEY] = {
    groups: input.groups,
    requests: input.requests,
    version: current.version + 1,
  } satisfies RequestLedger;
  return { ...input.session, state };
}

export function createRequestGroup(input: {
  readonly event?: PendingInputBatchEvent;
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
        owner: "session-turn",
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
      return record?.state === "open" ? [record.request] : [];
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
      groupIds.has(group.id) ? { ...group, completion: "delivered" } : group,
    ),
    requests: ledger.requests.map((request) =>
      groupIds.has(request.groupId) ? { ...request, state: "terminal" } : request,
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
  assertUniqueRequestIds(requests);
  return { groups, requests, version: 0 };
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
