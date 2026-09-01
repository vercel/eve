import type { ModelMessage, UserContent } from "ai";

import { resolveTextToResponses } from "#channel/resolve-text.js";
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
import type { HarnessSession, StepInput } from "#harness/types.js";
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
  readonly history?: readonly ModelMessage[];
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}): ResolvePendingInputResult {
  const baseHistory = [...(input.history ?? input.session.history)];
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

  const session = removePendingInputBatches(verdict.session, resolvedBatches);

  return finishResolvedInput({
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
    session,
  });
}

function resolveQuestionRoute(input: {
  readonly baseHistory: ModelMessage[];
  readonly batches: readonly PendingInputBatch[];
  readonly deferTurnInput: boolean;
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
    const session = removePendingInputBatches(verdict.session, [sole]);
    return {
      consumedMessage: input.resolvedStepInput.messageConsumed,
      outcome: "resolved",
      messages: verdict.messages,
      resolvedInputs: [buildResolvedInputBatch(sole, [])].filter(
        (batch): batch is NonNullable<typeof batch> => batch !== undefined,
      ),
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
      reduceQuestionRequestVerdict({
        batch,
        messages: state.messages,
        responses: input.responses,
        session: state.session,
      }),
  );
  const session = removePendingInputBatches(verdict.session, resolvedBatches);

  return finishResolvedInput({
    deferTurnInput: input.deferTurnInput,
    leftoverResponses,
    messages: verdict.messages,
    resolvedInputs: resolvedBatches.flatMap((batch) => {
      const resolved = buildResolvedInputBatch(batch, input.responses);
      return resolved === undefined ? [] : [resolved];
    }),
    resolvedStepInput: input.resolvedStepInput,
    session,
  });
}

function resolveSessionLimitRoute(input: {
  readonly baseHistory: ModelMessage[];
  readonly batches: readonly PendingInputBatch[];
  readonly deferTurnInput: boolean;
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
  const session = removePendingInputBatches(verdict.session, [input.pendingBatch]);

  return finishResolvedInput({
    deferTurnInput: input.deferTurnInput || limitBlocked,
    leftoverResponses,
    limitContinuation: verdict.limitContinuation,
    messages: verdict.messages,
    resolvedInputs: [buildResolvedInputBatch(input.pendingBatch, input.responses)].filter(
      (batch): batch is NonNullable<typeof batch> => batch !== undefined,
    ),
    resolvedStepInput: input.resolvedStepInput,
    session,
  });
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
