import type { ModelMessage } from "ai";

import { resolveTextToResponses } from "#channel/resolve-text.js";
import type { SessionAuthContext } from "#channel/types.js";
import { type AuthorizationChallenge, type AuthorizationResult } from "#harness/authorization.js";
import { normalizeUserContent } from "#harness/messages.js";
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
  applyAuthorizationResults,
  evaluatePendingAttempts,
  expireAttempts,
  reduceApprovalRecord,
  updateRecord,
} from "#harness/hitl/approval-attempts.js";
import {
  type ClosedAttemptStatus,
  type GroupCompletion,
  type OpenRequestGroup,
  type RequestGroup,
  type RequestGroupEvent,
  type RequestLedger,
  type RequestOutcome,
  type RequestRecord,
  type ResolvedInputActionBatch,
  isOpenRequest,
} from "#harness/hitl/request-ledger.js";

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

  // Attributed responses are the delivery boundary's responder-bound form of
  // the same answers; both feed one canonical response set.
  const deliveredResponses = materializeDeliveredResponses(stepInput, input.delivery.responder);
  const canonicalResponses = canonicalizeInputResponses(
    deliveredResponses.map((entry) => entry.response),
  );

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
    // A group that carries approvals settles only once every approval is
    // answered; question answers alone are held. Once the approvals settle,
    // its unanswered questions are dismissed with the group.
    const approvals = group.requests.filter((request) => isApprovalRequest(request));
    const approvalsAnswered =
      approvals.length > 0 && approvals.every((request) => responseMap.has(request.requestId));
    if (approvals.length > 0 && !approvalsAnswered) continue;
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
            approvalsAnswered ||
            (openGroups.length === 1 && normalizeUserContent(stepInput?.message) !== undefined)
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
  // Responses that resolved nothing this pass (answers to a group still
  // waiting on its approvals) are held with the step input.
  if (
    !hasForwardableTurnInput &&
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

/**
 * Every pending attempt is (re)evaluated on every delivery: a new attempt on
 * this pass, or one whose linked Authorization request was just satisfied.
 */

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
