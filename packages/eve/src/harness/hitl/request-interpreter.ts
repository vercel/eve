import type { ModelMessage, UserContent } from "ai";

import { resolveTextToResponses } from "#channel/resolve-text.js";
import type { SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import {
  buildApprovalResponseAuth,
  handleApprovalResponsePolicyError,
} from "#execution/tool-auth.js";
import {
  createApprovalCandidate,
  expireApprovalCandidates,
  finishApprovalCandidate,
  getActiveApprovalCandidate,
  getApprovalAuditState,
  markApprovalCandidateAuthorizationRequired,
  settleAllowedCandidate,
  settleDirectApprovalResponse,
  type ActiveApprovalResponseAttempt,
  type ApprovalSettlementAuditRecord,
} from "#harness/hitl/approval-response-attempts.js";
import {
  clearPendingAuthorization,
  getAuthorizationResult,
  getPendingAuthorization,
  isAuthorizationSignal,
  type AuthorizationChallenge,
} from "#harness/authorization.js";
import { extractHistoricalInputRequests } from "#harness/input-extraction.js";
import { buildResolvedInputBatch } from "#harness/input-request-resolution.js";
import { appendUserContent, normalizeUserContent } from "#harness/messages.js";
import { isSessionLimitContinuationRequestId } from "#harness/session-limit-continuation.js";
import {
  findAnsweredApprovalBatches,
  hasAnsweredApprovalBatch,
  limitApprovalTailBatch,
  reduceApprovalRequestVerdict,
} from "#harness/hitl/approval-input-requests.js";
import {
  compactStepInput,
  finishResolvedInput,
  responsesForBatches,
} from "#harness/hitl/pending-input-resolution.js";
import type {
  ResolvePendingInputResult,
  ResolvedStepInput,
} from "#harness/hitl/pending-input-resolution.js";
import {
  findAnsweredQuestionBatches,
  reduceQuestionRequestVerdict,
} from "#harness/hitl/question-input-requests.js";
import type { RequestVerdict } from "#harness/hitl/request-verdict.js";
import {
  hasAnsweredSessionLimitBatch,
  isSessionLimitInputBatch,
  reduceSessionLimitRequestVerdict,
} from "#harness/hitl/session-limit-input-requests.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import {
  getPendingInputBatches,
  queueDeferredStepInput,
  removePendingInputBatches,
} from "#harness/pending-input-batches.js";
import {
  listReadyRequestGroupDeliveries,
  prepareReadyRequestGroupDeliveries,
  readRequestLedger,
} from "#harness/hitl/request-ledger.js";
import type { HarnessSession, HarnessToolMap, StepInput } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

/**
 * Resolves pending input at the start of a harness step.
 *
 * Ordered batches remain independently answerable. Session-limit prompts own
 * resolution while open; approval batches preserve AI SDK's tail-message
 * requirement; question-only batches retain dismiss-and-continue behavior.
 */
export function interpretRequestDelivery(input: {
  readonly deferMessagesWhileApprovalsPending?: boolean;
  readonly durableGroupCompletionDelivery?: boolean;
  readonly history?: readonly ModelMessage[];
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}): ResolvePendingInputResult {
  const baseHistory = [...(input.history ?? input.session.history)];
  const readyDelivery =
    input.durableGroupCompletionDelivery === true
      ? listReadyRequestGroupDeliveries(input.session.state)[0]
      : undefined;
  if (readyDelivery !== undefined) {
    return {
      ...(readyDelivery.ownerCompletion as StoredRequestGroupCompletion),
      groupCompletionDeliveryKey: readyDelivery.deliveryKey,
      session: input.session,
    };
  }
  const batches = getPendingInputBatches(input.session.state);
  if (batches.length === 0) {
    return { outcome: "continue", messages: baseHistory, session: input.session };
  }

  const route = routePendingInput(batches);
  const deferTurnInput = hasTailApprovalResponse(baseHistory);
  const textResolutionBatch =
    route.kind === "session-limit" ? route.batch : batches.length === 1 ? batches[0] : undefined;
  const resolvedStepInput =
    textResolutionBatch === undefined
      ? input.stepInput
      : resolveTextMessageInput(textResolutionBatch, input.stepInput);
  const responses = canonicalizeInputResponses(resolvedStepInput?.inputResponses ?? []);

  if (
    route.kind === "approval" &&
    input.deferMessagesWhileApprovalsPending === true &&
    resolvedStepInput?.message !== undefined &&
    !hasAnsweredApprovalBatch(route.approvalBatches, responses)
  ) {
    return {
      deferredMessage: true,
      outcome: "unresolved",
      messages: baseHistory,
      session: queueDeferredStepInput(input.session, compactStepInput(resolvedStepInput)),
    };
  }

  if (responses.length === 0 && resolvedStepInput?.message === undefined) {
    const deferredInput = compactStepInput(resolvedStepInput);
    const session =
      deferredInput.context !== undefined ||
      readClientContext(deferredInput) !== undefined ||
      deferredInput.outputSchema !== undefined
        ? queueDeferredStepInput(input.session, deferredInput)
        : input.session;
    return { outcome: "unresolved", messages: baseHistory, session };
  }

  const resolverInput = {
    baseHistory,
    durableGroupCompletionDelivery: input.durableGroupCompletionDelivery,
    batches,
    deferTurnInput,
    resolvedStepInput,
    responses,
    session: input.session,
  };
  switch (route.kind) {
    case "session-limit":
      return resolveSessionLimitRoute({ ...resolverInput, pendingBatch: route.batch });
    case "approval":
      return resolveApprovalRoute({
        ...resolverInput,
        approvalBatches: route.approvalBatches,
        questionBatches: route.questionBatches,
        resolveApprovalKey: input.resolveApprovalKey,
      });
    case "question":
      return resolveQuestionRoute(resolverInput);
  }
}

type PendingInputRoute =
  | { readonly batch: PendingInputBatch; readonly kind: "session-limit" }
  | {
      readonly approvalBatches: readonly PendingInputBatch[];
      readonly kind: "approval";
      readonly questionBatches: readonly PendingInputBatch[];
    }
  | { readonly kind: "question" };

type PendingInputBatchDomain = "approval" | "question" | "session-limit";

function routePendingInput(batches: readonly PendingInputBatch[]): PendingInputRoute {
  const classified = batches.map((batch) => ({ batch, domain: classifyPendingInputBatch(batch) }));
  const limitBatch = classified.find(({ domain }) => domain === "session-limit")?.batch;
  if (limitBatch !== undefined) return { batch: limitBatch, kind: "session-limit" };

  const approvalBatches = classified
    .filter(({ domain }) => domain === "approval")
    .map(({ batch }) => batch);
  if (approvalBatches.length > 0) {
    const approvalSet = new Set(approvalBatches);
    return {
      approvalBatches,
      kind: "approval",
      questionBatches: batches.filter((batch) => !approvalSet.has(batch)),
    };
  }

  return { kind: "question" };
}

function classifyPendingInputBatch(batch: PendingInputBatch): PendingInputBatchDomain {
  for (const request of batch.requests) {
    switch (request.kind) {
      case "question":
      case "session-limit":
      case "tool-approval":
        break;
      default: {
        const unhandled: never = request.kind;
        throw new TypeError(`Unhandled pending input request kind: ${String(unhandled)}`);
      }
    }
  }

  if (isSessionLimitInputBatch(batch)) return "session-limit";
  return batch.requests.some((request) => isApprovalRequest(request)) ? "approval" : "question";
}

function resolveApprovalRoute(input: {
  readonly approvalBatches: readonly PendingInputBatch[];
  readonly baseHistory: ModelMessage[];
  readonly batches: readonly PendingInputBatch[];
  readonly deferTurnInput: boolean;
  readonly durableGroupCompletionDelivery?: boolean;
  readonly questionBatches: readonly PendingInputBatch[];
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly resolvedStepInput: ResolvedStepInput | undefined;
  readonly responses: readonly InputResponse[];
  readonly session: HarnessSession;
}): ResolvePendingInputResult {
  const answeredApprovalBatches = new Set(
    findAnsweredApprovalBatches(input.approvalBatches, input.responses),
  );
  const answeredQuestionBatches = new Set(
    findAnsweredQuestionBatches(input.questionBatches, input.responses),
  );
  let resolvedBatches = input.batches.filter(
    (batch) => answeredApprovalBatches.has(batch) || answeredQuestionBatches.has(batch),
  );
  resolvedBatches = limitApprovalTailBatch(resolvedBatches);

  const openBatches = input.batches.filter((batch) => !resolvedBatches.includes(batch));
  const leftoverResponses = responsesForBatches(input.responses, openBatches);

  if (resolvedBatches.length === 0) {
    if (input.resolvedStepInput?.message === undefined) {
      return {
        outcome: "unresolved",
        messages: [...input.baseHistory],
        session: queueDeferredStepInput(input.session, compactStepInput(input.resolvedStepInput)),
      };
    }

    const session =
      leftoverResponses.length === 0
        ? input.session
        : queueDeferredStepInput(input.session, { inputResponses: leftoverResponses });
    return {
      consumedMessage: input.resolvedStepInput.messageConsumed,
      outcome: "continue",
      messages: [...input.baseHistory],
      session,
    };
  }

  const verdict = reduceRequestVerdicts(
    resolvedBatches,
    {
      messages: [...input.baseHistory],
      session: input.session,
    },
    (batch, state) =>
      batch.requests.some((request) => isApprovalRequest(request))
        ? reduceApprovalRequestVerdict({
            batch,
            messages: state.messages,
            resolveApprovalKey: input.resolveApprovalKey,
            responses: input.responses,
            session: state.session,
          })
        : reduceQuestionRequestVerdict({
            batch,
            messages: state.messages,
            responses: input.responses,
            session: state.session,
          }),
  );

  return prepareResolvedGroupDelivery({
    enabled: input.durableGroupCompletionDelivery === true,
    batches: resolvedBatches,
    result: finishResolvedInput({
      deferTurnInput:
        resolvedBatches.some((batch) =>
          batch.requests.some((request) => isApprovalRequest(request)),
        ) || input.deferTurnInput,
      leftoverResponses,
      messages: verdict.messages,
      rejectedActions: verdict.rejectedActions,
      resolvedInputs: resolvedBatches.flatMap((batch) => {
        const resolved = buildResolvedInputBatch(batch, input.responses);
        return resolved === undefined ? [] : [resolved];
      }),
      resolvedStepInput: input.resolvedStepInput,
      session: verdict.session,
    }),
  });
}

function resolveQuestionRoute(input: {
  readonly baseHistory: ModelMessage[];
  readonly batches: readonly PendingInputBatch[];
  readonly deferTurnInput: boolean;
  readonly durableGroupCompletionDelivery?: boolean;
  readonly resolvedStepInput: ResolvedStepInput | undefined;
  readonly responses: readonly InputResponse[];
  readonly session: HarnessSession;
}): ResolvePendingInputResult {
  const resolvedBatches = findAnsweredQuestionBatches(input.batches, input.responses);
  const openBatches = input.batches.filter((batch) => !resolvedBatches.includes(batch));
  const leftoverResponses = responsesForBatches(input.responses, openBatches);

  if (resolvedBatches.length === 0) {
    if (input.resolvedStepInput?.message === undefined) {
      return {
        outcome: "unresolved",
        messages: [...input.baseHistory],
        session: queueDeferredStepInput(input.session, compactStepInput(input.resolvedStepInput)),
      };
    }

    const sole = input.batches.length === 1 ? input.batches[0] : undefined;
    if (sole === undefined) {
      const session =
        leftoverResponses.length === 0
          ? input.session
          : queueDeferredStepInput(input.session, { inputResponses: leftoverResponses });
      return {
        consumedMessage: input.resolvedStepInput.messageConsumed,
        outcome: "continue",
        messages: [...input.baseHistory],
        session,
      };
    }

    const verdict = reduceQuestionRequestVerdict({
      batch: sole,
      messages: [...input.baseHistory],
      responses: [],
      session: input.session,
    });
    return prepareResolvedGroupDelivery({
      enabled: input.durableGroupCompletionDelivery === true,
      batches: [sole],
      result: {
        consumedMessage: input.resolvedStepInput.messageConsumed,
        outcome: "resolved",
        messages: verdict.messages,
        resolvedInputs: [buildResolvedInputBatch(sole, [])].filter(
          (batch): batch is NonNullable<typeof batch> => batch !== undefined,
        ),
        session: verdict.session,
      },
    });
  }

  const verdict = reduceRequestVerdicts(
    resolvedBatches,
    {
      messages: [...input.baseHistory],
      session: input.session,
    },
    (batch, state) =>
      reduceQuestionRequestVerdict({
        batch,
        messages: state.messages,
        responses: input.responses,
        session: state.session,
      }),
  );
  return prepareResolvedGroupDelivery({
    enabled: input.durableGroupCompletionDelivery === true,
    batches: resolvedBatches,
    result: finishResolvedInput({
      deferTurnInput: input.deferTurnInput,
      leftoverResponses,
      messages: verdict.messages,
      resolvedInputs: resolvedBatches.flatMap((batch) => {
        const resolved = buildResolvedInputBatch(batch, input.responses);
        return resolved === undefined ? [] : [resolved];
      }),
      resolvedStepInput: input.resolvedStepInput,
      session: verdict.session,
    }),
  });
}

function resolveSessionLimitRoute(input: {
  readonly baseHistory: ModelMessage[];
  readonly batches: readonly PendingInputBatch[];
  readonly deferTurnInput: boolean;
  readonly durableGroupCompletionDelivery?: boolean;
  readonly pendingBatch: PendingInputBatch;
  readonly resolvedStepInput: ResolvedStepInput | undefined;
  readonly responses: readonly InputResponse[];
  readonly session: HarnessSession;
}): ResolvePendingInputResult {
  if (!hasAnsweredSessionLimitBatch(input.pendingBatch, input.responses)) {
    return {
      deferredMessage: true,
      outcome: "unresolved",
      messages: [...input.baseHistory],
      session: queueDeferredStepInput(input.session, compactStepInput(input.resolvedStepInput)),
    };
  }

  const openBatches = input.batches.filter((batch) => batch !== input.pendingBatch);
  const leftoverResponses = responsesForBatches(input.responses, openBatches);
  const limitBlocked = openBatches.some((batch) =>
    batch.requests.some((request) => isSessionLimitContinuationRequestId(request.requestId)),
  );
  const verdict = reduceSessionLimitRequestVerdict({
    batch: input.pendingBatch,
    messages: [...input.baseHistory],
    responses: input.responses,
    session: input.session,
  });
  return prepareResolvedGroupDelivery({
    enabled: input.durableGroupCompletionDelivery === true,
    batches: [input.pendingBatch],
    result: finishResolvedInput({
      deferTurnInput: input.deferTurnInput || limitBlocked,
      leftoverResponses,
      limitContinuation: verdict.limitContinuation,
      messages: verdict.messages,
      resolvedInputs: [buildResolvedInputBatch(input.pendingBatch, input.responses)].filter(
        (batch): batch is NonNullable<typeof batch> => batch !== undefined,
      ),
      resolvedStepInput: input.resolvedStepInput,
      session: verdict.session,
    }),
  });
}

type StoredRequestGroupCompletion = Omit<ResolvePendingInputResult, "session"> & {
  readonly outcome: "resolved";
};

function prepareResolvedGroupDelivery(input: {
  readonly batches: readonly PendingInputBatch[];
  readonly enabled: boolean;
  readonly result: ResolvePendingInputResult;
}): ResolvePendingInputResult {
  if (input.result.outcome !== "resolved") return input.result;
  if (!input.enabled) {
    return {
      ...input.result,
      session: removePendingInputBatches(input.result.session, input.batches),
    };
  }
  const requestIds = new Set(
    input.batches.flatMap((batch) => batch.requests.map((request) => request.requestId)),
  );
  const ledger = readRequestLedger(input.result.session.state);
  const groupIds = ledger.groups
    .filter(
      (group) =>
        group.completion === "waiting" && group.requestIds.some((id) => requestIds.has(id)),
    )
    .map((group) => group.id);
  if (groupIds.length === 0) return input.result;
  const deliveryKey = `request-group-completion:${JSON.stringify(groupIds)}`;
  const { session: _session, ...ownerCompletion } = input.result;
  const session = prepareReadyRequestGroupDeliveries({
    ownerCompletions: new Map(
      groupIds.map((groupId) => [groupId, { deliveryKey, ownerCompletion }]),
    ),
    session: input.result.session,
  });
  return {
    messages: input.result.messages,
    outcome: "ready",
    session,
  };
}

function reduceRequestVerdicts(
  batches: readonly PendingInputBatch[],
  initial: RequestVerdict,
  reduce: (batch: PendingInputBatch, state: RequestVerdict) => RequestVerdict,
): RequestVerdict {
  let state = initial;
  for (const batch of batches) {
    const verdict = reduce(batch, state);
    state = {
      messages: verdict.messages,
      rejectedActions:
        verdict.rejectedActions === undefined
          ? state.rejectedActions
          : [...(state.rejectedActions ?? []), ...verdict.rejectedActions],
      session: verdict.session,
    };
  }
  return state;
}

function canonicalizeInputResponses(responses: readonly InputResponse[]): readonly InputResponse[] {
  const byRequestId = new Map<string, InputResponse>();
  for (const response of responses) byRequestId.set(response.requestId, response);
  return [...byRequestId.values()];
}

function hasTailApprovalResponse(messages: readonly ModelMessage[]): boolean {
  const tail = messages.at(-1);
  return (
    tail?.role === "tool" && tail.content.some((part) => part.type === "tool-approval-response")
  );
}

function resolveTextMessageInput(
  pendingBatch: PendingInputBatch,
  stepInput: StepInput | undefined,
): ResolvedStepInput | undefined {
  if (typeof stepInput?.message !== "string") return stepInput;

  const batchRequestIds = new Set(pendingBatch.requests.map((request) => request.requestId));
  if (stepInput.inputResponses?.some((response) => batchRequestIds.has(response.requestId))) {
    return stepInput;
  }

  const responseAuthRequired = new Set(pendingBatch.responseAuthRequiredRequestIds ?? []);
  const textRequests = pendingBatch.requests.filter(
    (request) => !responseAuthRequired.has(request.requestId),
  );
  const responses = resolveTextToResponses(stepInput.message, textRequests);
  if (responses.length === 0) return stepInput;

  return compactStepInput({
    ...stepInput,
    inputResponses: [...(stepInput.inputResponses ?? []), ...responses],
    messageConsumed: true,
    message: undefined,
  });
}

type StaleResponseConversion =
  | {
      readonly kind: "unchanged";
      readonly stepInput?: StepInput;
    }
  | {
      readonly displayMessage: string | UserContent;
      readonly kind: "converted";
      readonly stepInput: StepInput;
    };

/**
 * Filter pass: removes stale answers to session-limit continuation prompts
 * from the step input before any stale handling runs.
 *
 * These are dropped rather than converted: surfacing a stale "Stop" as
 * conversational prose would read fail-open, and a stale grant must not
 * extend any budget — a currently pending prompt (if any) stays parked and
 * re-raises. Stripping the responses also keeps them from resolving (and
 * clearing) a pending batch they never answered. Answers to a currently
 * pending continuation prompt pass through untouched.
 */
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

  const {
    attributedInputResponses: _attributed,
    inputResponses: _responses,
    ...remainingInput
  } = input.stepInput;
  const result: { -readonly [K in keyof StepInput]: StepInput[K] } = remainingInput;
  if (retained.length > 0) result.inputResponses = retained;
  if (retainedAttributed.length > 0) result.attributedInputResponses = retainedAttributed;
  return result;
}

/**
 * Transformation pass: a response is stale when its request ID is not in
 * the currently pending HITL batch — the request was already answered,
 * cleared by a follow-up message, or cancelled.
 *
 * Responses for pending requests stay structured; stale responses become
 * plain user-message text. A stale response never reaches structured HITL
 * processing, so a stale approval cannot authorize an earlier tool call.
 * Request details recovered from history are best-effort model context.
 *
 * Assumes {@link dropStaleSessionLimitContinuationResponses} already ran:
 * stale continuation answers must never reach this conversion.
 */
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
    if (input.pendingRequestIds.has(entry.response.requestId)) {
      currentAttributed.push(entry);
    } else {
      staleResponses.push(entry.response);
    }
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
  const displayMessage = appendOptionalUserContent(
    input.stepInput.message,
    formatDisplayMessage(staleResponses, requests),
  );
  const {
    attributedInputResponses: _attributed,
    inputResponses: _responses,
    ...remainingInput
  } = input.stepInput;
  const stepInput: { -readonly [K in keyof StepInput]: StepInput[K] } = {
    ...remainingInput,
    message: modelMessage,
  };
  if (currentResponses.length > 0) stepInput.inputResponses = currentResponses;
  if (currentAttributed.length > 0) stepInput.attributedInputResponses = currentAttributed;

  return { displayMessage, kind: "converted", stepInput };
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
    if (response.optionId !== undefined) {
      responseDetails.optionId = response.optionId;
    }
    if (option !== undefined) {
      const selectedOption: { description?: string; id: string; label: string } = {
        id: option.id,
        label: option.label,
      };
      if (option.description !== undefined) {
        selectedOption.description = option.description;
      }
      responseDetails.selectedOption = selectedOption;
    }
    if (response.text !== undefined) {
      responseDetails.text = response.text;
    }

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
  // Request metadata can be missing (compacted history, subagent-proxied
  // request), so a response without it may still be an approval: default to
  // including the notice.
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
      if (response.text !== undefined && response.text.length > 0) {
        return response.text;
      }

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
  if (normalizedExisting === undefined) {
    return appended;
  }

  return appendUserContent({ appended, existing: normalizedExisting });
}

const UNAUTHENTICATED_APPROVAL_FEEDBACK = "Authentication is required to respond to this approval.";
const APPROVAL_AUTHORIZER_TIMEOUT_MS = 10_000;
const APPROVAL_CANDIDATE_TTL_MS = 10 * 60_000;

export interface ApprovalDeliveryResult {
  readonly challenges: readonly AuthorizationChallenge[];
  readonly feedback: readonly string[];
  readonly kind: "continue" | "continue-coordination" | "authorization-required" | "park";
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}

export function shouldPrepareApprovalResponsePolicies(input: {
  readonly now?: number;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}): boolean {
  const batches = getPendingInputBatches(input.session.state);
  const responses = [
    ...(input.stepInput?.attributedInputResponses ?? []).map(({ response }) => response),
    ...(input.stepInput?.inputResponses ?? []),
  ];
  if (
    batches.some((batch) =>
      batch.requests.some(
        (request) =>
          isApprovalRequest(request) &&
          responses.some((response) => response.requestId === request.requestId),
      ),
    )
  ) {
    return false;
  }

  const now = input.now ?? Date.now();
  return getApprovalAuditState(input.session.state).activeCandidates.some(
    (attempt) =>
      attempt.expiresAt > now &&
      (attempt.status === "pending" ||
        (getPendingAuthorization(input.session.state)?.challenges.some(
          (challenge) =>
            challenge.candidateId === attempt.candidateId &&
            getAuthorizationResult(challenge.name) !== undefined,
        ) ??
          false)),
  );
}

export async function interpretApprovalResponses(input: {
  readonly now?: number;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
  readonly tools: HarnessToolMap;
}): Promise<ApprovalDeliveryResult> {
  const now = input.now ?? Date.now();
  const expiredChallengeNames = getApprovalAuditState(input.session.state)
    .activeCandidates.filter((attempt) => attempt.expiresAt <= now)
    .flatMap(
      (attempt) =>
        getPendingAuthorization(input.session.state)
          ?.challenges.filter((challenge) => challenge.candidateId === attempt.candidateId)
          .map((challenge) => challenge.name) ?? [],
    );
  const expiredState = expireApprovalCandidates({ now, state: input.session.state });
  let session: HarnessSession = {
    ...input.session,
    state: clearPendingAuthorization(expiredState, expiredChallengeNames),
  };
  const audit = getApprovalAuditState(session.state);
  const batches = getPendingInputBatches(session.state);
  const pendingRequestIds = new Set(
    batches.flatMap((batch) => batch.requests.map((request) => request.requestId)),
  );
  const pendingSettlements = audit.settlements.filter((settlement) =>
    pendingRequestIds.has(settlement.requestId),
  );
  const settledRequestIds = new Set(audit.settlements.map((settlement) => settlement.requestId));
  const discardedDuplicate = hasResponseForRequest(input.stepInput, settledRequestIds);
  const deduplicatedInput = discardedDuplicate
    ? removeConsumedResponses(input.stepInput, settledRequestIds)
    : input.stepInput;
  if (
    discardedDuplicate &&
    pendingSettlements.length === 0 &&
    !hasMeaningfulInput(deduplicatedInput)
  ) {
    return deliveryResult(session, deduplicatedInput, "park");
  }
  if (batches.length === 0) return deliveryResult(session, deduplicatedInput);

  const stepInput = deduplicatedInput;
  const authorizationRequiredRequestIds = new Set(
    batches.flatMap((batch) => batch.responseAuthRequiredRequestIds ?? []),
  );
  const allRequests = batches.flatMap((batch) => batch.requests);
  const requests = new Map(allRequests.map((request) => [request.requestId, request]));
  const challenges: AuthorizationChallenge[] = [];
  const feedback: string[] = [];
  const consumed = new Set<string>();
  let didCommit = false;
  const attemptsAtStart = getApprovalAuditState(session.state).activeCandidates;

  const deliveredResponses = [
    ...(stepInput?.attributedInputResponses ?? []),
    ...(stepInput?.inputResponses ?? []).map((response) => ({
      auth: undefined,
      deliveryId: undefined,
      response,
    })),
  ];
  for (const { auth: attributedResponder, deliveryId, response } of deliveredResponses) {
    const request = requests.get(response.requestId);
    if (request === undefined || !isApprovalRequest(request)) continue;

    const requiresAuthorization = authorizationRequiredRequestIds.has(response.requestId);
    if (!requiresAuthorization) {
      const context = contextStorage.getStore();
      const responder =
        attributedResponder !== undefined
          ? attributedResponder
          : (context?.get(AuthKey) ?? context?.get(SessionKey)?.auth.current ?? null);
      if (
        responder !== null &&
        (response.optionId === "approve" || response.optionId === "cancel")
      ) {
        const settled = settleDirectApprovalResponse({
          actor: responder,
          outcome: response.optionId === "approve" ? "allowed" : "cancelled",
          requestId: response.requestId,
          settledAt: now,
          state: session.state,
        });
        session = { ...session, state: settled.state };
        didCommit ||= settled.changed;
      }
      continue;
    }
    consumed.add(response.requestId);

    if (response.optionId === "cancel") {
      const responder =
        attributedResponder !== undefined
          ? attributedResponder
          : buildCallbackContext().session.auth.current;
      if (responder === null) {
        feedback.push(UNAUTHENTICATED_APPROVAL_FEEDBACK);
        continue;
      }
      const settled = settleDirectApprovalResponse({
        actor: responder,
        outcome: "cancelled",
        requestId: response.requestId,
        settledAt: now,
        state: session.state,
      });
      session = { ...session, state: settled.state };
      didCommit ||= settled.changed;
      continue;
    }

    if (response.optionId !== "approve") continue;
    const responder =
      attributedResponder !== undefined
        ? attributedResponder
        : buildCallbackContext().session.auth.current;
    if (responder === null) {
      feedback.push(UNAUTHENTICATED_APPROVAL_FEEDBACK);
      continue;
    }

    const created = createApprovalCandidate({
      candidateIdPrefix: approvalCandidateIdPrefix(request.requestId, responder),
      createdAt: now,
      deliveryId,
      expiresAt: now + APPROVAL_CANDIDATE_TTL_MS,
      requestId: request.requestId,
      responder,
      state: session.state,
    });
    session = { ...session, state: created.state };
    didCommit ||= created.changed;
  }

  const remainingStepInput = removeConsumedResponses(stepInput, consumed);
  if (consumed.size > 0) {
    return deliveryResult(
      session,
      remainingStepInput,
      didCommit ? "continue-coordination" : "continue",
      [],
      feedback,
    );
  }
  if (didCommit) {
    return deliveryResult(session, remainingStepInput, "continue", [], feedback);
  }

  const parkedChallengeNames = new Set(
    getPendingAuthorization(session.state)?.challenges.map((challenge) => challenge.name) ?? [],
  );
  for (const attempt of attemptsAtStart) {
    if (attempt.status === "authorization-required") {
      const attemptChallenges =
        getPendingAuthorization(session.state)?.challenges.filter(
          (challenge) => challenge.candidateId === attempt.candidateId,
        ) ?? [];
      const hasCallback = attemptChallenges.some(
        (challenge) => getAuthorizationResult(challenge.name) !== undefined,
      );
      if (!hasCallback) {
        challenges.push(
          ...attemptChallenges.filter((challenge) => !parkedChallengeNames.has(challenge.name)),
        );
        continue;
      }
    }

    const request = requests.get(attempt.requestId);
    if (
      request === undefined ||
      getActiveApprovalCandidate(session.state, attempt.candidateId) === undefined
    ) {
      continue;
    }
    const processed = await authorizeCandidate({
      candidateId: attempt.candidateId,
      now,
      request,
      responder: attempt.responder,
      session,
      tools: input.tools,
    });
    session = processed.session;
    didCommit ||= processed.didCommit;
    challenges.push(...processed.challenges);
    const settlement = getApprovalAuditState(session.state).settlements.find(
      (entry) => entry.requestId === attempt.requestId,
    );
    if (settlement !== undefined) pendingSettlements.push(settlement);
  }

  const resumedStepInput = appendSettledResponses(remainingStepInput, pendingSettlements);
  if (pendingSettlements.length > 0) {
    return deliveryResult(session, resumedStepInput, "continue");
  }
  return didCommit
    ? deliveryResult(session, resumedStepInput, "continue-coordination")
    : deliveryResult(
        session,
        resumedStepInput,
        challenges.length > 0 ? "authorization-required" : "continue",
        challenges,
      );
}

async function authorizeCandidate(input: {
  readonly candidateId: string;
  readonly now: number;
  readonly request: InputRequest;
  readonly responder: ActiveApprovalResponseAttempt["responder"];
  readonly session: HarnessSession;
  readonly tools: HarnessToolMap;
}): Promise<{
  readonly challenges: readonly AuthorizationChallenge[];
  readonly didCommit: boolean;
  readonly session: HarnessSession;
}> {
  let session = {
    ...input.session,
    state: expireApprovalCandidates({ now: input.now, state: input.session.state }),
  };
  if (getActiveApprovalCandidate(session.state, input.candidateId) === undefined) {
    return { challenges: [], didCommit: false, session };
  }

  const approval = input.tools.get(input.request.action.toolName)?.approval;
  const responsePolicy =
    approval !== undefined && typeof approval !== "function" ? approval.response : undefined;
  if (responsePolicy === undefined) {
    return failCandidate({
      ...input,
      reason: "Approval authorization is temporarily unavailable. Please try again.",
      session,
    });
  }

  try {
    const context = buildCallbackContext();
    const outcome = await withAuthorizerTimeout(
      Promise.resolve(
        responsePolicy({
          auth: buildApprovalResponseAuth({
            responder: input.responder,
            scope: input.candidateId,
          }),
          request: {
            callId: input.request.action.callId,
            requestId: input.request.requestId,
            toolInput: input.request.action.input,
            toolName: input.request.action.toolName,
          },
          response: { decision: "approve" },
          responder: input.responder,
          session: {
            id: context.session.id,
            initiator: context.session.auth.initiator,
            parent: context.session.parent,
            turn: context.session.turn,
          },
        }),
      ),
    );
    if (outcome.status === "rejected") {
      session = {
        ...session,
        state: finishApprovalCandidate({
          candidateId: input.candidateId,
          completedAt: input.now,
          reason: outcome.reason,
          state: session.state,
          status: "rejected",
        }),
      };
      return { challenges: [], didCommit: true, session };
    }
    if (outcome.status !== "allowed") {
      return failCandidate({ ...input, session });
    }

    const settled = settleAllowedCandidate({
      candidateId: input.candidateId,
      settledAt: input.now,
      state: session.state,
    });
    return {
      challenges: [],
      didCommit: settled.changed,
      session: { ...session, state: settled.state },
    };
  } catch (error) {
    const authorization = await handleApprovalResponsePolicyError(error).catch(() => undefined);
    if (isAuthorizationSignal(authorization)) {
      const providerExpiresAt = authorization.challenges
        .map((entry) => Date.parse(entry.challenge.expiresAt ?? ""))
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
      session = {
        ...session,
        state: markApprovalCandidateAuthorizationRequired({
          authorizationChallenges: authorization.challenges.map((challenge) => ({
            ...challenge,
            candidateId: input.candidateId,
          })),
          candidateId: input.candidateId,
          expiresAt: providerExpiresAt,
          state: session.state,
        }),
      };
      return {
        challenges: authorization.challenges.map((challenge) => ({
          ...challenge,
          candidateId: input.candidateId,
        })),
        didCommit: true,
        session,
      };
    }
    return failCandidate({ ...input, session });
  }
}

async function failCandidate(input: {
  readonly candidateId: string;
  readonly now: number;
  readonly request: InputRequest;
  readonly reason?: string;
  readonly responder: ActiveApprovalResponseAttempt["responder"];
  readonly session: HarnessSession;
  readonly tools: HarnessToolMap;
}): Promise<{
  readonly challenges: readonly AuthorizationChallenge[];
  readonly didCommit: boolean;
  readonly session: HarnessSession;
}> {
  return {
    challenges: [],
    didCommit: true,
    session: {
      ...input.session,
      state: finishApprovalCandidate({
        candidateId: input.candidateId,
        completedAt: input.now,
        reason: input.reason,
        state: input.session.state,
        status: "failed",
      }),
    },
  };
}

function approvalCandidateIdPrefix(requestId: string, responder: SessionAuthContext): string {
  return `${requestId}:${responder.authenticator}:${responder.principalType}:${responder.principalId}`;
}

function hasResponseForRequest(stepInput: StepInput | undefined, requestIds: Set<string>): boolean {
  return [
    ...(stepInput?.attributedInputResponses ?? []).map(({ response }) => response),
    ...(stepInput?.inputResponses ?? []),
  ].some((response) => requestIds.has(response.requestId));
}

function removeConsumedResponses(
  stepInput: StepInput | undefined,
  consumedRequestIds: Set<string>,
): StepInput | undefined {
  if (stepInput === undefined || consumedRequestIds.size === 0) return stepInput;
  const attributedInputResponses = stepInput.attributedInputResponses?.filter(
    ({ response }) => !consumedRequestIds.has(response.requestId),
  );
  const inputResponses = stepInput.inputResponses?.filter(
    (response) => !consumedRequestIds.has(response.requestId),
  );
  return {
    ...stepInput,
    attributedInputResponses:
      attributedInputResponses && attributedInputResponses.length > 0
        ? attributedInputResponses
        : undefined,
    inputResponses: inputResponses && inputResponses.length > 0 ? inputResponses : undefined,
  };
}

function appendSettledResponses(
  stepInput: StepInput | undefined,
  settlements: readonly ApprovalSettlementAuditRecord[],
): StepInput | undefined {
  if (settlements.length === 0) return stepInput;
  return {
    ...stepInput,
    inputResponses: [
      ...(stepInput?.inputResponses ?? []),
      ...settlements.map((settlement) => ({
        optionId: settlement.outcome === "allowed" ? "approve" : "cancel",
        requestId: settlement.requestId,
      })),
    ],
  };
}

function hasMeaningfulInput(stepInput: StepInput | undefined): boolean {
  return Boolean(
    stepInput?.message ||
    (stepInput?.context && stepInput.context.length > 0) ||
    (stepInput?.inputResponses && stepInput.inputResponses.length > 0) ||
    (stepInput?.attributedInputResponses && stepInput.attributedInputResponses.length > 0),
  );
}

function deliveryResult(
  session: HarnessSession,
  stepInput?: StepInput,
  kind: ApprovalDeliveryResult["kind"] = "continue",
  challenges: readonly AuthorizationChallenge[] = [],
  feedback: readonly string[] = [],
): ApprovalDeliveryResult {
  return { challenges, feedback, kind, session, stepInput };
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
