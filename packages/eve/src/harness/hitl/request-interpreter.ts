import type { ModelMessage, UserContent } from "ai";

import { resolveTextToResponses } from "#channel/resolve-text.js";
import type { SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import {
  buildApprovalResponseAuth,
  handleApprovalResponsePolicyError,
} from "#execution/tool-auth.js";
import {
  isAuthorizationSignal,
  type AuthorizationChallenge,
  type AuthorizationResult,
} from "#harness/authorization.js";
import { extractHistoricalInputRequests } from "#harness/input-extraction.js";
import { appendUserContent, normalizeUserContent } from "#harness/messages.js";
import { isSessionLimitContinuationRequestId } from "#harness/session-limit-continuation.js";
import {
  limitApprovalTailBatch,
  reduceApprovalRequestVerdict,
} from "#harness/hitl/approval-input-requests.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import { reduceQuestionRequestVerdict } from "#harness/hitl/question-input-requests.js";
import {
  hasAnsweredSessionLimitBatch,
  isSessionLimitInputBatch,
  reduceSessionLimitRequestVerdict,
} from "#harness/hitl/session-limit-input-requests.js";
import type { HarnessToolMap, StepInput } from "#harness/types.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
import { isInputRequest, type InputRequest, type InputResponse } from "#shared/input.js";
import {
  authorizationRequestId,
  type ClosedAttempt,
  type ClosedAttemptStatus,
  type ResponseAttempt,
  type GroupCompletion,
  type OpenRequestGroup,
  type RequestGroup,
  type RequestGroupEvent,
  type RequestLedger,
  type RequestOutcome,
  type RequestRecord,
  type ResolvedInputActionBatch,
  isOpenRequest,
  openAuthorizationRequests,
} from "#harness/hitl/request-ledger.js";

const UNAUTHENTICATED_APPROVAL_FEEDBACK = "Authentication is required to respond to this approval.";
const APPROVAL_AUTHORIZER_TIMEOUT_MS = 10_000;
const APPROVAL_CANDIDATE_TTL_MS = 10 * 60_000;

export interface RequestDelivery {
  readonly now: number;
  readonly stepInput?: StepInput;
  readonly authorizationResults: readonly AuthorizationResult[];
  readonly responder: SessionAuthContext | null;
}

/** Live approval policies; looked up per pass and never persisted. */
export type ApprovalPolicyLookup = HarnessToolMap;

export interface InterpretRequestsInput {
  readonly delivery: RequestDelivery;
  readonly history: readonly ModelMessage[];
  readonly ledger: RequestLedger;
  readonly policies: ApprovalPolicyLookup;
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly deferMessagesWhileApprovalsPending: boolean;
}

export type RequestEffect =
  | { readonly kind: "feedback"; readonly message: string }
  | {
      readonly kind: "authorization-required";
      readonly challenges: readonly AuthorizationChallenge[];
    }
  | {
      readonly kind: "authorization-completed";
      readonly requestId: string;
      readonly outcome: "completed" | "failed";
      readonly reason?: string;
    }
  | {
      readonly kind: "approval-attempt";
      readonly attemptId: string;
      readonly requestId: string;
      readonly status: ClosedAttemptStatus | "pending";
      readonly responderPrincipalId: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "approval-settled";
      readonly requestId: string;
      readonly outcome: "approved" | "cancelled";
      readonly responderPrincipalId: string;
    }
  | {
      readonly kind: "input-resolved";
      readonly group: RequestGroupEvent;
      readonly resolutions: readonly InputResolution[];
    }
  | {
      readonly kind: "action-rejected";
      readonly group: RequestGroupEvent;
      readonly results: readonly import("#shared/action-types.js").RuntimeToolResultActionResult[];
    };

export type InterpretRequestsResult =
  | {
      readonly kind: "wait";
      readonly ledger: RequestLedger;
      readonly effects: readonly RequestEffect[];
      readonly heldInput?: StepInput;
    }
  | {
      readonly kind: "continue";
      readonly ledger: RequestLedger;
      readonly effects: readonly RequestEffect[];
      /** The text message was consumed as a request response and must not reach the model. */
      readonly messageConsumed?: boolean;
      readonly stepInput?: StepInput;
      readonly messages: readonly ModelMessage[];
    }
  | {
      readonly kind: "complete";
      readonly ledger: RequestLedger;
      readonly effects: readonly RequestEffect[];
      /** The text message was consumed as a request response and must not reach the model. */
      readonly messageConsumed?: boolean;
      readonly deliveryKey: string;
      readonly completions: readonly GroupCompletion[];
      readonly messages: readonly ModelMessage[];
      readonly stepInput?: StepInput;
    };

export interface ReducerInput {
  readonly group: OpenRequestGroup;
  readonly records: readonly RequestRecord[];
  readonly responses: readonly InputResponse[];
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly messages: readonly ModelMessage[];
}

export interface ReducerResult {
  readonly outcomes: ReadonlyMap<string, RequestOutcome>;
  readonly messages: readonly ModelMessage[];
  readonly rejectedActions?: readonly ResolvedInputActionBatch[];
  readonly approvedToolKeys?: readonly string[];
  readonly limitContinuation?: { readonly granted: boolean };
}

export interface InputResolution {
  readonly outcome: "answered" | "approved" | "denied" | "ignored" | "invalid";
  readonly request: InputRequest;
  readonly response?: InputResponse;
}

export async function interpretRequests(
  input: InterpretRequestsInput,
): Promise<InterpretRequestsResult> {
  let ledger = expireAttempts(input.ledger, input.delivery.now);
  const authorizationPass = applyAuthorizationResults(
    ledger,
    input.delivery.authorizationResults,
    input.delivery.now,
  );
  ledger = authorizationPass.ledger;
  const effects: RequestEffect[] = [...authorizationPass.effects];

  const openGroups = materializeOpenGroups(ledger);

  let stepInput: ResolvedStepInput | undefined = input.delivery.stepInput;

  const sessionLimitGroup = openGroups.find((group) => isSessionLimitInputBatch(group));
  const textResolutionGroup =
    sessionLimitGroup ?? (openGroups.length === 1 ? openGroups[0] : undefined);
  if (textResolutionGroup !== undefined) {
    stepInput = resolveTextMessageInput(textResolutionGroup, stepInput);
  }

  const canonicalResponses = canonicalizeInputResponses(stepInput?.inputResponses ?? []);
  const deliveredResponses = materializeDeliveredResponses(stepInput, input.delivery.responder);

  if (
    input.deferMessagesWhileApprovalsPending &&
    stepInput?.message !== undefined &&
    hasOpenApprovalGroup(openGroups) &&
    sessionLimitGroup === undefined &&
    !hasAnyApprovalResponse(openGroups, canonicalResponses)
  ) {
    return { kind: "wait", ledger, effects, heldInput: compactStepInput(stepInput) };
  }
  // An open Limit prompt owns resolution: unrelated turn input waits behind it.
  if (
    sessionLimitGroup !== undefined &&
    !hasAnsweredSessionLimitBatch(sessionLimitGroup, canonicalResponses)
  ) {
    return { kind: "wait", ledger, effects, heldInput: compactStepInput(stepInput) };
  }

  const recordsById = new Map(ledger.requests.map((record) => [record.id, record]));
  const groupResponses = new Map<string, InputResponse[]>();
  for (const group of openGroups) groupResponses.set(group.id, []);
  for (const response of canonicalResponses) {
    const record = recordsById.get(response.requestId);
    if (record?.groupId !== undefined && groupResponses.has(record.groupId)) {
      groupResponses.get(record.groupId)!.push(response);
    }
  }

  for (const group of openGroups) {
    const responseMap = new Map<string, InputResponse>(
      (groupResponses.get(group.id) ?? []).map(
        (response) => [response.requestId, response] as const,
      ),
    );
    for (const request of group.requests) {
      const record = ledger.requests.find((candidate) => candidate.id === request.requestId);
      if (record === undefined || record.outcome !== undefined) continue;
      switch (request.kind) {
        case "tool-approval":
          ledger = await reduceApprovalRecord({
            delivery: input.delivery,
            effects,
            group,
            ledger,
            policyLookup: input.policies,
            record,
            requiresAuthorization: (group.responseAuthRequiredRequestIds ?? []).includes(
              request.requestId,
            ),
            response: responseMap.get(request.requestId),
            responder: resolveResponderForRequest(
              request.requestId,
              deliveredResponses,
              input.delivery.responder,
            ),
          });
          break;
        case "question":
          if (responseMap.has(request.requestId)) {
            ledger = updateRecord(ledger, request.requestId, {
              ...record,
              outcome: {
                kind: "answered",
                response: responseMap.get(request.requestId)!,
                at: input.delivery.now,
              },
            });
          } else if (
            openGroups.length === 1 &&
            normalizeUserContent(stepInput?.message) !== undefined
          ) {
            ledger = updateRecord(ledger, request.requestId, {
              ...record,
              outcome: { kind: "ignored", at: input.delivery.now },
            });
          }
          break;
        case "session-limit": {
          const responses = groupResponses.get(group.id) ?? [];
          if (responses.length > 0 && hasAnsweredSessionLimitBatch(group, responses)) {
            const response = responses.find(
              (candidate) => candidate.requestId === request.requestId,
            );
            ledger = updateRecord(ledger, request.requestId, {
              ...record,
              outcome:
                response === undefined
                  ? { kind: "ignored", at: input.delivery.now }
                  : { kind: "answered", response, at: input.delivery.now },
            });
          }
          break;
        }
      }
    }
  }

  ledger = await evaluatePendingAttempts({
    delivery: input.delivery,
    effects,
    ledger,
    policyLookup: input.policies,
  });

  // Completion is judged over the groups that were open at pass start: a
  // group whose every request just became terminal has no open requests left.
  const refreshedOpenGroups = openGroups;
  const completableGroups = refreshedOpenGroups.filter((group) =>
    group.requests.every(
      (request) =>
        ledger.requests.find((record) => record.id === request.requestId)?.outcome !== undefined,
    ),
  );
  const completedGroups = limitApprovalTailBatch(completableGroups);
  const completedGroupIds = completedGroups.map((group) => group.id);
  const deliveryKey =
    completedGroupIds.length > 0
      ? `request-group-completion:${JSON.stringify(completedGroupIds)}`
      : undefined;

  const completions: GroupCompletion[] = [];
  let messages = [...input.history];
  let heldResponses: InputResponse[] = [];

  for (const group of completedGroups) {
    const records = group.requests
      .map((request) => ledger.requests.find((record) => record.id === request.requestId))
      .filter((record): record is RequestRecord => record !== undefined);
    const responses = groupResponses.get(group.id) ?? [];
    const reduced = buildGroupCompletion(group, {
      group,
      messages,
      records,
      resolveApprovalKey: input.resolveApprovalKey,
      responses,
    });
    messages = [...reduced.messages];
    if (group.event !== undefined) {
      effects.push({
        kind: "input-resolved",
        group: group.event,
        resolutions: buildInputResolutions(group, records, responses),
      });
    }
    for (const rejected of reduced.rejectedActions ?? []) {
      effects.push({ kind: "action-rejected", group: rejected.event, results: rejected.results });
    }
    completions.push(toGroupCompletion(group, reduced));
  }

  // Responses that reached a group still waiting after this pass are held for
  // the next step; responses to completed groups were consumed above.
  for (const group of refreshedOpenGroups) {
    if (completedGroupIds.includes(group.id)) continue;
    heldResponses = [...heldResponses, ...(groupResponses.get(group.id) ?? [])];
  }

  if (deliveryKey !== undefined) {
    const completionMap = new Map(
      completions.map((completion) => [completion.owner, completion] as const),
    );
    ledger = {
      ...ledger,
      groups: ledger.groups.map((group) =>
        completedGroupIds.includes(group.id)
          ? {
              ...group,
              completion: {
                deliveryKey,
                ownerCompletion: completionMap.get(group.owner) ?? completions[0]!,
                status: "ready" as const,
              },
            }
          : group,
      ),
    };
  }

  // AI SDK collects approval responses only from the tail tool message, so
  // turn input replays after an isolated approval response; a still-open Limit
  // prompt likewise holds turn input.
  const limitStillOpen = materializeOpenGroups(ledger).some((group) =>
    group.requests.some((request) => isSessionLimitContinuationRequestId(request.requestId)),
  );
  const deferred = finishStepInput({
    deferTurnInput:
      completedGroups.some((group) =>
        group.requests.some((request) => isApprovalRequest(request)),
      ) ||
      hasTailApprovalResponse(input.history) ||
      (completedGroups.length > 0 && limitStillOpen),
    heldResponses,
    resolvedStepInput: stepInput,
  });

  if (deliveryKey !== undefined) {
    return {
      completions,
      deliveryKey,
      effects,
      kind: "complete",
      messageConsumed: stepInput?.messageConsumed,
      ledger,
      messages,
      stepInput: deferred.stepInput,
    };
  }

  const refreshedStillOpenGroups = materializeOpenGroups(ledger);
  const hasForwardableTurnInput =
    normalizeUserContent(stepInput?.message) !== undefined ||
    (stepInput?.context?.length ?? 0) > 0 ||
    (readClientContext(stepInput)?.length ?? 0) > 0;
  const hasStructuredResponses = canonicalResponses.length > 0;

  if (
    !hasForwardableTurnInput &&
    !hasStructuredResponses &&
    (refreshedStillOpenGroups.length > 0 || deferred.stepInput !== undefined)
  ) {
    return { kind: "wait", ledger, effects, heldInput: deferred.stepInput };
  }

  return {
    effects,
    kind: "continue",
    ledger,
    messageConsumed: stepInput?.messageConsumed,
    messages,
    stepInput: deferred.stepInput,
  };
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

export function appendResolvedBatchTranscript(
  messages: ModelMessage[],
  group: OpenRequestGroup,
  toolParts: readonly Extract<ModelMessage, { role: "tool" }>["content"][number][],
): void {
  messages.push(...group.responseMessages);
  if (toolParts.length > 0) {
    messages.push({ content: [...toolParts], role: "tool" });
  }
}

export function compactStepInput(input: ResolvedStepInput | undefined): ResolvedStepInput {
  if (input === undefined) return {};
  const result: {
    attributedInputResponses?: StepInput["attributedInputResponses"];
    context?: StepInput["context"];
    inputResponses?: StepInput["inputResponses"];
    message?: StepInput["message"];
    messageConsumed?: boolean;
    outputSchema?: StepInput["outputSchema"];
  } = {};
  if ((input.attributedInputResponses?.length ?? 0) > 0)
    result.attributedInputResponses = input.attributedInputResponses;
  if ((input.context?.length ?? 0) > 0) result.context = input.context;
  if ((input.inputResponses?.length ?? 0) > 0) result.inputResponses = input.inputResponses;
  if (input.message !== undefined) result.message = input.message;
  if (input.messageConsumed === true) result.messageConsumed = true;
  if (input.outputSchema !== undefined) result.outputSchema = input.outputSchema;
  return attachClientContext(result, readClientContext(input));
}

export function dropStaleSessionLimitContinuationResponses(input: {
  readonly pendingRequestIds: ReadonlySet<string>;
  readonly stepInput?: StepInput;
}): StepInput | undefined {
  if (input.stepInput === undefined) return undefined;
  const responses = input.stepInput.inputResponses ?? [];
  const attributed = input.stepInput.attributedInputResponses ?? [];
  const keep = (requestId: string) =>
    input.pendingRequestIds.has(requestId) || !isSessionLimitContinuationRequestId(requestId);
  const retained = responses.filter((response) => keep(response.requestId));
  const retainedAttributed = attributed.filter(({ response }) => keep(response.requestId));
  if (retained.length === responses.length && retainedAttributed.length === attributed.length) {
    return input.stepInput;
  }
  const { attributedInputResponses: _a, inputResponses: _r, ...remaining } = input.stepInput;
  const result: { -readonly [K in keyof StepInput]: StepInput[K] } = remaining;
  if (retained.length > 0) result.inputResponses = retained;
  if (retainedAttributed.length > 0) result.attributedInputResponses = retainedAttributed;
  return result;
}

type StaleResponseConversion =
  | { readonly kind: "unchanged"; readonly stepInput?: StepInput }
  | {
      readonly kind: "converted";
      readonly displayMessage: string | UserContent;
      readonly stepInput: StepInput;
    };

export function convertStaleResponsesToUserMessage(input: {
  readonly history: readonly ModelMessage[];
  readonly pendingRequestIds: ReadonlySet<string>;
  readonly stepInput?: StepInput;
}): StaleResponseConversion {
  if (input.stepInput === undefined) return { kind: "unchanged" };
  const responses = input.stepInput.inputResponses ?? [];
  const attributed = input.stepInput.attributedInputResponses ?? [];
  if (responses.length === 0 && attributed.length === 0) {
    return { kind: "unchanged", stepInput: input.stepInput };
  }

  const currentResponses: InputResponse[] = [];
  const currentAttributed: NonNullable<StepInput["attributedInputResponses"]>[number][] = [];
  const staleResponses: InputResponse[] = [];
  for (const response of responses) {
    (input.pendingRequestIds.has(response.requestId) ? currentResponses : staleResponses).push(
      response,
    );
  }
  for (const entry of attributed) {
    if (input.pendingRequestIds.has(entry.response.requestId)) currentAttributed.push(entry);
    else staleResponses.push(entry.response);
  }
  if (staleResponses.length === 0) {
    return { kind: "unchanged", stepInput: input.stepInput };
  }

  const requests = extractHistoricalInputRequests({
    history: input.history,
    requestIds: new Set(staleResponses.map((response) => response.requestId)),
  });
  const modelMessage = appendOptionalUserContent(
    input.stepInput.message,
    formatModelMessage(staleResponses, requests),
  );
  const displayBase =
    typeof input.stepInput.message === "string" ? input.stepInput.message : undefined;
  const displayMessage = appendOptionalUserContent(
    displayBase,
    formatDisplayMessage(staleResponses, requests),
  );
  const { attributedInputResponses: _a, inputResponses: _r, ...remaining } = input.stepInput;
  const stepInput: { -readonly [K in keyof StepInput]: StepInput[K] } = {
    ...remaining,
    message: modelMessage,
  };
  if (currentResponses.length > 0) stepInput.inputResponses = currentResponses;
  if (currentAttributed.length > 0) stepInput.attributedInputResponses = currentAttributed;
  return { displayMessage, kind: "converted", stepInput };
}

type ResolvedStepInput = StepInput & { readonly messageConsumed?: boolean };

function materializeOpenGroups(ledger: RequestLedger): OpenRequestGroup[] {
  const requests = new Map(ledger.requests.map((request) => [request.id, request]));
  return ledger.groups.flatMap((group) => {
    if (group.completion !== "waiting") return [];
    const open: InputRequest[] = [];
    for (const id of group.requestIds) {
      const record = requests.get(id);
      if (record !== undefined && isOpenRequest(record) && isInputRequest(record.request)) {
        open.push(record.request);
      }
    }
    return open.length === 0 ? [] : [{ ...group, requests: open }];
  });
}

function hasOpenApprovalGroup(groups: readonly OpenRequestGroup[]): boolean {
  return groups.some((group) => group.requests.some((request) => isApprovalRequest(request)));
}

function hasAnyApprovalResponse(
  groups: readonly OpenRequestGroup[],
  responses: readonly InputResponse[],
): boolean {
  const ids = new Set(
    groups.flatMap((group) =>
      group.requests
        .filter((request) => isApprovalRequest(request))
        .map((request) => request.requestId),
    ),
  );
  return responses.some((response) => ids.has(response.requestId));
}

function materializeDeliveredResponses(
  stepInput: StepInput | undefined,
  fallbackResponder: SessionAuthContext | null,
): readonly {
  readonly responder: SessionAuthContext | null;
  readonly deliveryId?: string;
  readonly response: InputResponse;
}[] {
  return [
    ...(stepInput?.attributedInputResponses ?? []).map(({ auth, deliveryId, response }) => ({
      deliveryId,
      responder: auth,
      response,
    })),
    ...(stepInput?.inputResponses ?? []).map((response) => ({
      responder: fallbackResponder,
      response,
    })),
  ];
}

function resolveResponderForRequest(
  requestId: string,
  deliveredResponses: readonly {
    readonly responder: SessionAuthContext | null;
    readonly deliveryId?: string;
    readonly response: InputResponse;
  }[],
  fallbackResponder: SessionAuthContext | null,
): { readonly responder: SessionAuthContext | null; readonly deliveryId?: string } {
  const match = deliveredResponses.find((entry) => entry.response.requestId === requestId);
  return { deliveryId: match?.deliveryId, responder: match?.responder ?? fallbackResponder };
}

async function reduceApprovalRecord(input: {
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
 * Every pending attempt is (re)evaluated on every delivery: a new attempt on
 * this pass, or one whose linked Authorization request was just satisfied.
 */
async function evaluatePendingAttempts(input: {
  readonly delivery: RequestDelivery;
  readonly effects: RequestEffect[];
  readonly ledger: RequestLedger;
  readonly policyLookup: ApprovalPolicyLookup;
}): Promise<RequestLedger> {
  let ledger = input.ledger;
  for (const record of input.ledger.requests) {
    if (record.outcome !== undefined) continue;
    for (const attempt of record.attempts ?? []) {
      if (attempt.status !== "pending") continue;
      const current = ledger.requests.find((candidate) => candidate.id === record.id);
      if (current === undefined || current.outcome !== undefined) break;
      ledger = await evaluateApprovalAttempt({
        attemptId: attempt.id,
        delivery: input.delivery,
        effects: input.effects,
        ledger,
        policyLookup: input.policyLookup,
        recordId: record.id,
      });
    }
  }
  return ledger;
}

function expireAttempts(ledger: RequestLedger, now: number): RequestLedger {
  let next = ledger;
  for (const record of ledger.requests) {
    if (
      !isInputRequest(record.request) ||
      !isApprovalRequest(record.request) ||
      record.outcome !== undefined
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

function applyAuthorizationResults(
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

async function evaluateApprovalAttempt(input: {
  readonly attemptId: string;
  readonly delivery: RequestDelivery;
  readonly effects: RequestEffect[];
  readonly ledger: RequestLedger;
  readonly policyLookup: ApprovalPolicyLookup;
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

function updateRecord(
  ledger: RequestLedger,
  recordId: string,
  record: RequestRecord,
): RequestLedger {
  return {
    ...ledger,
    requests: ledger.requests.map((candidate) => (candidate.id === recordId ? record : candidate)),
  };
}

function buildGroupCompletion(group: OpenRequestGroup, input: ReducerInput): ReducerResult {
  if (isSessionLimitInputBatch(group)) return reduceSessionLimitRequestVerdict(input);
  if (group.requests.some((request) => isApprovalRequest(request)))
    return reduceApprovalRequestVerdict(input);
  return reduceQuestionRequestVerdict(input);
}

function toGroupCompletion(group: RequestGroup, result: ReducerResult): GroupCompletion {
  if (group.owner === "framework-approval-gate") {
    return {
      approvedToolKeys: result.approvedToolKeys ?? [],
      messages: result.messages,
      owner: "framework-approval-gate",
      rejectedActions: result.rejectedActions ?? [],
    };
  }
  return {
    limitContinuation: result.limitContinuation,
    messages: result.messages,
    owner: "session-turn",
  };
}

function buildInputResolutions(
  group: OpenRequestGroup,
  records: readonly RequestRecord[],
  responses: readonly InputResponse[],
): readonly InputResolution[] {
  const responseMap = new Map(responses.map((response) => [response.requestId, response] as const));
  const recordMap = new Map(records.map((record) => [record.id, record] as const));
  return group.requests.map((request) => ({
    outcome: classifyResolutionOutcome(
      recordMap.get(request.requestId)?.outcome,
      responseMap.get(request.requestId),
    ),
    request,
    response: responseMap.get(request.requestId),
  }));
}

function classifyResolutionOutcome(
  outcome: RequestOutcome | undefined,
  response: InputResponse | undefined,
): InputResolution["outcome"] {
  switch (outcome?.kind) {
    case "answered":
      return "answered";
    case "approved":
      return "approved";
    case "denied":
      return "denied";
    case "ignored":
      return "ignored";
    default:
      return response === undefined ? "ignored" : "invalid";
  }
}

function finishStepInput(input: {
  readonly deferTurnInput: boolean;
  readonly heldResponses: readonly InputResponse[];
  readonly resolvedStepInput: ResolvedStepInput | undefined;
}): {
  readonly deferredContext?: boolean;
  readonly deferredMessage?: boolean;
  readonly stepInput?: StepInput;
} {
  const deferredInput: {
    context?: StepInput["context"];
    inputResponses?: StepInput["inputResponses"];
    message?: StepInput["message"];
  } = {};
  let clientContext: readonly string[] | undefined;
  if (input.heldResponses.length > 0) deferredInput.inputResponses = input.heldResponses;
  if (input.deferTurnInput) {
    if ((input.resolvedStepInput?.context?.length ?? 0) > 0) {
      deferredInput.context = input.resolvedStepInput?.context;
    }
    const resolvedClientContext = readClientContext(input.resolvedStepInput);
    if ((resolvedClientContext?.length ?? 0) > 0) clientContext = resolvedClientContext;
    if (
      input.resolvedStepInput?.message !== undefined &&
      input.resolvedStepInput.messageConsumed !== true
    ) {
      deferredInput.message = input.resolvedStepInput.message;
    }
  }
  attachClientContext(deferredInput, clientContext);
  const stepInput = Object.keys(deferredInput).length > 0 ? deferredInput : undefined;
  return {
    deferredContext:
      stepInput?.context === undefined && readClientContext(stepInput) === undefined
        ? undefined
        : true,
    deferredMessage: stepInput?.message === undefined ? undefined : true,
    stepInput,
  };
}

function resolveTextMessageInput(
  group: OpenRequestGroup,
  stepInput: StepInput | undefined,
): ResolvedStepInput | undefined {
  if (typeof stepInput?.message !== "string") return stepInput;
  const groupRequestIds = new Set(group.requests.map((request) => request.requestId));
  if (stepInput.inputResponses?.some((response) => groupRequestIds.has(response.requestId))) {
    return stepInput;
  }
  const responseAuthRequired = new Set(group.responseAuthRequiredRequestIds ?? []);
  const textRequests = group.requests.filter(
    (request) => !responseAuthRequired.has(request.requestId),
  );
  const responses = resolveTextToResponses(stepInput.message, textRequests);
  if (responses.length === 0) return stepInput;
  return compactStepInput({
    ...stepInput,
    inputResponses: [...(stepInput.inputResponses ?? []), ...responses],
    messageConsumed: true,
  });
}

function canonicalizeInputResponses(responses: readonly InputResponse[]): readonly InputResponse[] {
  const byRequestId = new Map<string, InputResponse>();
  for (const response of responses) byRequestId.set(response.requestId, response);
  return [...byRequestId.values()];
}

function formatModelMessage(
  responses: readonly InputResponse[],
  requests: ReadonlyMap<string, InputRequest>,
): string {
  const resolvedResponses = responses.map((response) => {
    const request = requests.get(response.requestId);
    const option = request?.options?.find((candidate) => candidate.id === response.optionId);
    const responseDetails: {
      optionId?: string;
      selectedOption?: { description?: string; id: string; label: string };
      text?: string;
    } = {};
    if (response.optionId !== undefined) responseDetails.optionId = response.optionId;
    if (option !== undefined) {
      const selectedOption: { description?: string; id: string; label: string } = {
        id: option.id,
        label: option.label,
      };
      if (option.description !== undefined) selectedOption.description = option.description;
      responseDetails.selectedOption = selectedOption;
    }
    if (response.text !== undefined) responseDetails.text = response.text;
    const resolved: {
      prompt?: string;
      requestId: string;
      requestType?: "approval" | "question";
      response: typeof responseDetails;
    } = { requestId: response.requestId, response: responseDetails };
    if (request !== undefined) {
      resolved.prompt = request.prompt;
      resolved.requestType = isApprovalRequest(request) ? "approval" : "question";
    }
    return resolved;
  });
  const mayIncludeApproval = responses.some((response) => {
    const request = requests.get(response.requestId);
    return request === undefined || isApprovalRequest(request);
  });
  const approvalNotice = mayIncludeApproval
    ? " This does not authorize an earlier action; request approval again if that action is still needed."
    : "";
  return [
    "The user submitted the following response to an earlier interactive prompt.",
    `Treat it as new input at the current point in the conversation and decide whether it is still relevant.${approvalNotice}`,
    JSON.stringify(resolvedResponses, null, 2),
  ].join("\n");
}

function formatDisplayMessage(
  responses: readonly InputResponse[],
  requests: ReadonlyMap<string, InputRequest>,
): string {
  return responses
    .map((response) => {
      if (response.text !== undefined && response.text.length > 0) return response.text;
      const option = requests
        .get(response.requestId)
        ?.options?.find((candidate) => candidate.id === response.optionId);
      return option?.label ?? response.optionId ?? "Response to an earlier interactive prompt";
    })
    .join("\n");
}

function appendOptionalUserContent(
  existing: string | UserContent | undefined,
  appended: string,
): string | UserContent {
  const normalizedExisting = normalizeUserContent(existing);
  if (normalizedExisting === undefined) return appended;
  return appendUserContent({ appended, existing: normalizedExisting });
}

function hasTailApprovalResponse(history: readonly ModelMessage[]): boolean {
  const tail = history.at(-1);
  return (
    tail?.role === "tool" &&
    Array.isArray(tail.content) &&
    tail.content.some(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "tool-approval-response",
    )
  );
}

function providerExpiry(challenges: readonly AuthorizationChallenge[]): number | undefined {
  const values = challenges
    .map((entry) => Date.parse(entry.challenge.expiresAt ?? ""))
    .filter((value) => Number.isFinite(value));
  return values.length > 0 ? values.sort((a, b) => a - b)[0] : undefined;
}

function projectResponder(responder: SessionAuthContext) {
  return {
    authenticator: responder.authenticator,
    issuer: responder.issuer,
    principalId: responder.principalId,
    principalType: responder.principalType,
  };
}

function approvalResponseAttemptId(input: {
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

async function withAuthorizerTimeout<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () => reject(new Error("Approval response policy timed out.")),
        APPROVAL_AUTHORIZER_TIMEOUT_MS,
      );
    }),
  ]);
}
