import type { SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import {
  buildApprovalResponseAuth,
  handleApprovalResponsePolicyError,
} from "#execution/tool-auth.js";
import { isAuthorizationSignal, type AuthorizationResult } from "#harness/authorization.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import type { HarnessToolMap } from "#harness/types.js";
import type {
  ClosedAttempt,
  OpenRequestGroup,
  ClosedAttemptStatus,
  RequestLedger,
  RequestRecord,
  ResponseAttempt,
} from "#harness/hitl/request-ledger.js";
import {
  authorizationRequestId,
  isOpenRequest,
  openAuthorizationRequests,
} from "#harness/hitl/request-ledger.js";
import type {
  ApprovalPolicyLookup,
  RequestDelivery,
  RequestEffect,
} from "#harness/hitl/request-interpreter.js";
import { isInputRequest, type InputResponse } from "#shared/input.js";

const APPROVAL_AUTHORIZER_TIMEOUT_MS = 10_000;
const UNAUTHENTICATED_APPROVAL_FEEDBACK = "Authentication is required to respond to this approval.";
const APPROVAL_CANDIDATE_TTL_MS = 10 * 60_000;

export function expireAttempts(ledger: RequestLedger, now: number): RequestLedger {
  let next = ledger;
  for (const record of ledger.requests) {
    if (
      !isInputRequest(record.request) ||
      !isApprovalRequest(record.request) ||
      !isOpenRequest(record)
    ) {
      continue;
    }
    const retained: ResponseAttempt[] = [];
    const expired: ClosedAttempt[] = [];
    for (const attempt of record.attempts ?? []) {
      if (attempt.expiresAt > now) retained.push(attempt);
      else expired.push({ ...attempt, completedAt: now, status: "timed-out" });
    }
    if (expired.length === 0) continue;
    next = updateRecord(next, record.id, {
      ...record,
      attemptHistory: [...(record.attemptHistory ?? []), ...expired],
      attempts: retained.length > 0 ? retained : undefined,
    });
  }
  return next;
}

export function applyAuthorizationResults(
  ledger: RequestLedger,
  results: readonly AuthorizationResult[],
  now: number,
): { readonly ledger: RequestLedger; readonly effects: readonly RequestEffect[] } {
  let next = ledger;
  const effects: RequestEffect[] = [];
  for (const result of results) {
    const authorizationRecord = openAuthorizationRequests(next).find(
      (record) =>
        (result.attemptId !== undefined &&
          record.request.authorization.attemptId === result.attemptId) ||
        (result.attemptId === undefined && record.request.authorization.hookUrl === result.hookUrl),
    );
    if (authorizationRecord === undefined) continue;
    next = updateRecord(next, authorizationRecord.id, {
      ...authorizationRecord,
      outcome: { kind: "authorized", result, at: now },
    });
    effects.push({
      kind: "authorization-completed",
      outcome: "completed",
      requestId: authorizationRecord.id,
    });
    const attemptId = authorizationRecord.request.responseAttemptId;
    if (attemptId === undefined) continue;
    const owner = next.requests.find((record) =>
      (record.attempts ?? []).some((attempt) => attempt.id === attemptId),
    );
    if (owner === undefined) continue;
    next = updateRecord(next, owner.id, {
      ...owner,
      attempts: (owner.attempts ?? []).map((attempt) =>
        attempt.id !== attemptId
          ? attempt
          : {
              ...attempt,
              authorizationRequestIds: attempt.authorizationRequestIds.filter(
                (id) => id !== authorizationRecord.id,
              ),
              status:
                attempt.authorizationRequestIds.filter((id) => id !== authorizationRecord.id)
                  .length === 0
                  ? "pending"
                  : "awaiting-authorization",
            },
      ),
    });
  }
  return { effects, ledger: next };
}

export async function evaluatePendingAttempts(input: {
  readonly delivery: RequestDelivery;
  readonly effects: RequestEffect[];
  readonly ledger: RequestLedger;
  readonly policyLookup: HarnessToolMap;
}): Promise<RequestLedger> {
  let ledger = input.ledger;
  const recordIds = input.ledger.requests.map((record) => record.id);
  for (const recordId of recordIds) {
    const record = ledger.requests.find((candidate) => candidate.id === recordId);
    if (record === undefined || record.outcome !== undefined) continue;
    for (const attempt of record.attempts ?? []) {
      if (attempt.status !== "pending") continue;
      const current = ledger.requests.find((candidate) => candidate.id === recordId);
      if (current === undefined || current.outcome !== undefined) break;
      ledger = await evaluateApprovalAttempt({
        attemptId: attempt.id,
        delivery: input.delivery,
        effects: input.effects,
        ledger,
        policyLookup: input.policyLookup,
        recordId,
      });
    }
  }
  return ledger;
}

async function evaluateApprovalAttempt(input: {
  readonly attemptId: string;
  readonly delivery: RequestDelivery;
  readonly effects: RequestEffect[];
  readonly ledger: RequestLedger;
  readonly policyLookup: HarnessToolMap;
  readonly recordId: string;
}): Promise<RequestLedger> {
  const record = input.ledger.requests.find((candidate) => candidate.id === input.recordId);
  const attempt = record?.attempts?.find((candidate) => candidate.id === input.attemptId);
  if (
    record === undefined ||
    attempt === undefined ||
    !isInputRequest(record.request) ||
    !isApprovalRequest(record.request)
  ) {
    return input.ledger;
  }
  if (attempt.expiresAt <= input.delivery.now) return input.ledger;
  const approval = input.policyLookup.get(record.request.action.toolName)?.approval;
  const responsePolicy =
    approval !== undefined && typeof approval !== "function" ? approval.response : undefined;
  if (responsePolicy === undefined) {
    return closeApprovalAttempt(input.ledger, input.recordId, input.attemptId, {
      completedAt: input.delivery.now,
      reason: "Approval authorization is temporarily unavailable. Please try again.",
      status: "failed",
    });
  }

  try {
    const context = buildCallbackContext();
    const rawOutcome = await withAuthorizerTimeout(
      Promise.resolve(
        responsePolicy({
          auth: buildApprovalResponseAuth({ responder: attempt.responder, scope: attempt.id }),
          request: {
            callId: record.request.action.callId,
            requestId: record.request.requestId,
            toolInput: record.request.action.input,
            toolName: record.request.action.toolName,
          },
          response: { decision: "approve" },
          responder: attempt.responder,
          session: {
            id: context.session.id,
            initiator: context.session.auth.initiator,
            parent: context.session.parent,
            turn: context.session.turn,
          },
        }),
      ),
    );
    const outcome = rawOutcome as {
      readonly status: "allowed" | "rejected";
      readonly reason?: string;
    };
    if (outcome.status === "rejected") {
      input.effects.push({
        kind: "approval-attempt",
        attemptId: attempt.id,
        requestId: record.id,
        reason: outcome.reason,
        responderPrincipalId: attempt.responder.principalId,
        status: "rejected",
      });
      return closeApprovalAttempt(input.ledger, input.recordId, input.attemptId, {
        completedAt: input.delivery.now,
        reason: outcome.reason,
        status: "rejected",
      });
    }
    input.effects.push({
      kind: "approval-settled",
      outcome: "approved",
      requestId: record.id,
      responderPrincipalId: attempt.responder.principalId,
    });
    return updateRecord(input.ledger, record.id, {
      ...record,
      attemptHistory: [
        ...(record.attemptHistory ?? []),
        { ...attempt, completedAt: input.delivery.now, status: "allowed" },
      ],
      attempts: (record.attempts ?? []).filter((candidate) => candidate.id !== attempt.id),
      outcome: {
        kind: "approved",
        actor: projectResponder(attempt.responder),
        attemptId: attempt.id,
        at: input.delivery.now,
      },
    });
  } catch (error) {
    const authorization = await handleApprovalResponsePolicyError(error).catch(() => undefined);
    if (isAuthorizationSignal(authorization)) {
      const challenges = authorization.challenges.map((challenge) => ({
        ...challenge,
        candidateId: attempt.id,
      }));
      const requestIds = challenges.map((challenge) =>
        authorizationRequestId({ challenge, responseAttemptId: attempt.id }),
      );
      input.effects.push({ kind: "authorization-required", challenges });
      let next = updateRecord(input.ledger, record.id, {
        ...record,
        attempts: (record.attempts ?? []).map((candidate) =>
          candidate.id !== attempt.id
            ? candidate
            : {
                ...candidate,
                authorizationRequestIds: requestIds,
                expiresAt: Math.min(
                  candidate.expiresAt,
                  providerExpiry(challenges) ?? candidate.expiresAt,
                ),
                status: "awaiting-authorization",
              },
        ),
      });
      const additions: RequestRecord[] = challenges.map((challenge) => {
        const id = authorizationRequestId({ challenge, responseAttemptId: attempt.id });
        return {
          id,
          request: {
            authorization: challenge,
            kind: "authorization",
            requestId: id,
            responseAttemptId: attempt.id,
          },
        };
      });
      next = {
        ...next,
        requests: [
          ...next.requests.filter((existing) => !requestIds.includes(existing.id)),
          ...additions,
        ],
      };
      return next;
    }
    input.effects.push({
      kind: "approval-attempt",
      attemptId: attempt.id,
      requestId: record.id,
      responderPrincipalId: attempt.responder.principalId,
      status: "failed",
    });
    return closeApprovalAttempt(input.ledger, input.recordId, input.attemptId, {
      completedAt: input.delivery.now,
      status: "failed",
    });
  }
}

function closeApprovalAttempt(
  ledger: RequestLedger,
  recordId: string,
  attemptId: string,
  closed: {
    readonly completedAt: number;
    readonly status: ClosedAttemptStatus;
    readonly reason?: string;
  },
): RequestLedger {
  const record = ledger.requests.find((candidate) => candidate.id === recordId);
  const attempt = record?.attempts?.find((candidate) => candidate.id === attemptId);
  if (record === undefined || attempt === undefined) return ledger;
  return updateRecord(ledger, recordId, {
    ...record,
    attemptHistory: [
      ...(record.attemptHistory ?? []),
      { ...attempt, completedAt: closed.completedAt, reason: closed.reason, status: closed.status },
    ],
    attempts: (record.attempts ?? []).filter((candidate) => candidate.id !== attemptId),
  });
}

export function updateRecord(
  ledger: RequestLedger,
  recordId: string,
  record: RequestRecord,
): RequestLedger {
  return {
    ...ledger,
    requests: ledger.requests.map((candidate) => (candidate.id === recordId ? record : candidate)),
  };
}

export function projectResponder(responder: ResponseAttempt["responder"]) {
  return {
    authenticator: responder.authenticator,
    issuer: responder.issuer,
    principalId: responder.principalId,
    principalType: responder.principalType,
  };
}

function providerExpiry(
  challenges: readonly { readonly challenge: { readonly expiresAt?: string | number } }[],
): number | undefined {
  const expirations = challenges
    .map((challenge) => challenge.challenge.expiresAt)
    .filter((value): value is number => typeof value === "number");
  if (expirations.length === 0) return undefined;
  return Math.min(...expirations);
}

async function withAuthorizerTimeout<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () => reject(new Error("Approval response authorizer timed out.")),
        APPROVAL_AUTHORIZER_TIMEOUT_MS,
      );
    }),
  ]);
}

export function approvalResponseAttemptId(input: {
  readonly deliveryId?: string;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
}): string {
  if (input.deliveryId !== undefined) return `${input.requestId}:${input.deliveryId}`;
  return [
    "compat",
    input.requestId,
    input.responder.authenticator,
    input.responder.issuer ?? "",
    input.responder.principalType,
    input.responder.principalId,
  ].join(":");
}

export async function reduceApprovalRecord(input: {
  readonly delivery: RequestDelivery;
  readonly effects: RequestEffect[];
  readonly group: OpenRequestGroup;
  readonly ledger: RequestLedger;
  readonly policyLookup: ApprovalPolicyLookup;
  readonly record: RequestRecord;
  readonly requiresAuthorization: boolean;
  readonly response: InputResponse | undefined;
  readonly responder: {
    readonly responder: SessionAuthContext | null;
    readonly deliveryId?: string;
  };
}): Promise<RequestLedger> {
  if (input.response === undefined || !isInputRequest(input.record.request)) return input.ledger;
  // A responder identity is only mandatory when the tool's response policy
  // must judge it; plain approvals settle on the response alone.
  if (input.response.optionId === "cancel" || input.response.optionId === "deny") {
    const actor = input.responder.responder;
    if (actor === null && input.requiresAuthorization) {
      input.effects.push({ kind: "feedback", message: UNAUTHENTICATED_APPROVAL_FEEDBACK });
      return input.ledger;
    }
    const staleHistory = (input.record.attempts ?? []).map((attempt): ClosedAttempt => ({
      ...attempt,
      completedAt: input.delivery.now,
      reason: "The waiting request was cancelled.",
      status: "stale",
    }));
    if (actor !== null) {
      input.effects.push({
        kind: "approval-settled",
        outcome: "cancelled",
        requestId: input.record.id,
        responderPrincipalId: actor.principalId,
      });
    }
    return updateRecord(input.ledger, input.record.id, {
      ...input.record,
      attemptHistory: [...(input.record.attemptHistory ?? []), ...staleHistory],
      attempts: undefined,
      outcome: {
        kind: "denied",
        actor: actor === null ? undefined : projectResponder(actor),
        at: input.delivery.now,
      },
    });
  }
  if (input.response.optionId !== "approve") {
    // Any other option is an invalid approval answer: denied, no responder needed.
    return updateRecord(input.ledger, input.record.id, {
      ...input.record,
      outcome: { kind: "denied", at: input.delivery.now },
    });
  }
  const actor = input.responder.responder;
  if (!input.requiresAuthorization) {
    if (actor !== null) {
      input.effects.push({
        kind: "approval-settled",
        outcome: "approved",
        requestId: input.record.id,
        responderPrincipalId: actor.principalId,
      });
    }
    return updateRecord(input.ledger, input.record.id, {
      ...input.record,
      outcome: {
        kind: "approved",
        actor: actor === null ? undefined : projectResponder(actor),
        at: input.delivery.now,
      },
    });
  }
  if (actor === null) {
    input.effects.push({ kind: "feedback", message: UNAUTHENTICATED_APPROVAL_FEEDBACK });
    return input.ledger;
  }
  const attemptId = approvalResponseAttemptId({
    deliveryId: input.responder.deliveryId,
    requestId: input.record.id,
    responder: actor,
  });
  if ((input.record.attempts ?? []).some((attempt) => attempt.id === attemptId))
    return input.ledger;
  const nextAttempts = [
    ...(input.record.attempts ?? []),
    {
      authorizationRequestIds: [],
      createdAt: input.delivery.now,
      deliveryId: input.responder.deliveryId,
      expiresAt: input.delivery.now + APPROVAL_CANDIDATE_TTL_MS,
      id: attemptId,
      responder: actor,
      status: "pending" as const,
    },
  ] as const;
  let ledger = updateRecord(input.ledger, input.record.id, {
    ...input.record,
    attempts: nextAttempts,
  });
  input.effects.push({
    kind: "approval-attempt",
    attemptId,
    requestId: input.record.id,
    responderPrincipalId: actor.principalId,
    status: "pending",
  });
  return ledger;
}

/**
 * Whether this step may replay a previously approved tool call: either policy
 * work is pending, or the delivery approves an open Approval outright.
 * Persisted dynamic tool metadata must be current before either path runs.
 */
export function hasApprovalReplayWork(input: {
  readonly authorizationResults: readonly AuthorizationResult[];
  readonly ledger: RequestLedger;
  readonly now: number;
  readonly responses: readonly InputResponse[];
}): boolean {
  if (hasPendingApprovalPolicyWork(input.ledger, input.now, input.authorizationResults)) {
    return true;
  }
  const approved = new Set(
    input.responses
      .filter((response) => response.optionId === "approve")
      .map((response) => response.requestId),
  );
  return input.ledger.requests.some(
    (record) =>
      isOpenRequest(record) &&
      isInputRequest(record.request) &&
      isApprovalRequest(record.request) &&
      approved.has(record.id),
  );
}

export function hasPendingApprovalPolicyWork(
  ledger: RequestLedger,
  now: number,
  authorizationResults: readonly AuthorizationResult[],
): boolean {
  const satisfied = new Set(
    authorizationResults.map((result) => result.attemptId ?? result.hookUrl),
  );
  return ledger.requests.some((record) => {
    if (
      !isInputRequest(record.request) ||
      !isApprovalRequest(record.request) ||
      record.outcome !== undefined
    ) {
      return false;
    }
    return (record.attempts ?? []).some((attempt) => {
      if (attempt.expiresAt <= now) return false;
      if (attempt.status === "pending") return true;
      return attempt.authorizationRequestIds.some((requestId) => {
        const authRecord = ledger.requests.find((candidate) => candidate.id === requestId);
        return (
          authRecord?.request.kind === "authorization" &&
          satisfied.has(
            authRecord.request.authorization.attemptId ?? authRecord.request.authorization.hookUrl,
          )
        );
      });
    });
  });
}
