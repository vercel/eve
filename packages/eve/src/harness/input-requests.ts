import type { ModelMessage } from "ai";

import type {
  RuntimeToolCallActionRequest,
  RuntimeToolResultActionResult,
} from "#runtime/actions/types.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import { resolveTextToResponses } from "#channel/resolve-text.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import type { PendingInputBatch, PendingInputBatchEvent } from "#harness/pending-input-batches.js";
import {
  getPendingInputBatches,
  queueDeferredStepInput,
  removePendingInputBatches,
} from "#harness/pending-input-batches.js";
import { resolveToolCallInputObject } from "#harness/runtime-actions.js";
import {
  isSessionLimitContinuationRequest,
  resolveSessionLimitContinuation,
} from "#harness/session-limit-continuation.js";
import type { HarnessSession, StepInput } from "#harness/types.js";

export {
  appendPendingInputBatch,
  consumeDeferredStepInput,
  getPendingInputRequestIds,
  hasDeferredStepInput,
  hasPendingInputBatch,
} from "#harness/pending-input-batches.js";

const APPROVED_TOOLS_KEY = "eve.runtime.hitl.approvedTools";

const IGNORED_INPUT_REASON = "Ignored because the user continued without responding.";

const TOOL_EXECUTION_DENIED_CODE = "TOOL_EXECUTION_DENIED";
const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution was denied.";
const TOOL_EXECUTION_INVALID_APPROVAL_MESSAGE = "Invalid approval response.";
const SESSION_LIMIT_BATCH_INVARIANT_MESSAGE =
  "Session-limit pending input batches must contain only session-limit requests.";

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];

/**
 * Denied tool-call approvals from one resolved batch, ready for the caller to
 * emit as `rejected` `action.result` events against the originating turn.
 */
export interface RejectedActionBatch {
  readonly event: PendingInputBatchEvent;
  readonly results: readonly RuntimeToolResultActionResult[];
}

type ApprovalTerminalStatus = "approved" | "denied" | "ignored" | "invalid";

/**
 * Returns true when the step input carries user-facing turn input.
 */
export function hasStepInput(input?: StepInput): boolean {
  if (input === undefined) {
    return false;
  }

  return input.message !== undefined || (input.inputResponses?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Pending input resolution
// ---------------------------------------------------------------------------

/**
 * Resolves pending input at the start of a harness step.
 *
 * Pending requests live in ordered batches, one per parked assistant turn.
 * A batch resolves as a unit when one delivery answers every `"required"`
 * request in it; its withheld model output is then restored behind the
 * current history. Responses that answer
 * only part of a batch wait in the deferred step input until the rest
 * arrives.
 *
 * A plain message never waits behind a tool approval: it runs as an
 * ordinary turn while the approval batch stays open and answerable. Only a
 * session-limit prompt still holds messages back — the budget gate must not
 * run the model. A message behind a single question-only batch keeps its
 * dismiss-and-continue behavior.
 *
 * Tool approval responses additionally resolve with at most one
 * approval-bearing batch per internal step because AI SDK only collects
 * approval responses from the tail tool message. Session-limit prompts take
 * exclusive ownership of resolution until answered.
 */
export function resolvePendingInput(input: {
  readonly history?: readonly ModelMessage[];
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}): ResolvePendingInputResult {
  const baseHistory = [...(input.history ?? input.session.history)];
  const batches = getPendingInputBatches(input.session.state);

  // No pending batches -- pass through to the model call.
  if (batches.length === 0) {
    return { outcome: "continue", messages: baseHistory, session: input.session };
  }

  const route = routePendingInput(batches);
  const deferTurnInput = hasTailApprovalResponse(baseHistory);
  // A session-limit prompt owns text matching even when other batches are
  // open. Otherwise a bare option word remains ambiguous across batches.
  const textResolutionBatch =
    route.kind === "session-limit" ? route.batch : batches.length === 1 ? batches[0] : undefined;
  const resolvedStepInput: (StepInput & { readonly messageConsumed?: boolean }) | undefined =
    textResolutionBatch === undefined
      ? input.stepInput
      : resolveTextMessageInput(textResolutionBatch, input.stepInput);
  const responses = canonicalizeInputResponses(resolvedStepInput?.inputResponses ?? []);

  if (responses.length === 0 && resolvedStepInput?.message === undefined) {
    const deferredInput = compactStepInput(resolvedStepInput);
    let session = input.session;
    if (deferredInput.context !== undefined || deferredInput.outputSchema !== undefined) {
      session = queueDeferredStepInput(session, deferredInput);
    }
    return { outcome: "unresolved", messages: baseHistory, session };
  }

  switch (route.kind) {
    case "session-limit":
      return resolveSessionLimitInput({
        baseHistory,
        batches,
        deferTurnInput,
        pendingBatch: route.batch,
        resolvedStepInput,
        responses,
        session: input.session,
      });
    case "approval":
      return resolveApprovalInputBatches({
        approvalBatches: route.approvalBatches,
        baseHistory,
        batches: route.batches,
        deferTurnInput,
        questionBatches: route.questionBatches,
        resolveApprovalKey: input.resolveApprovalKey,
        resolvedStepInput,
        responses,
        session: input.session,
      });
    case "question":
      return resolveQuestionOnlyInputBatches({
        baseHistory,
        batches: route.batches,
        deferTurnInput,
        resolvedStepInput,
        responses,
        session: input.session,
      });
  }
}

type PendingInputRoute =
  | { readonly batch: PendingInputBatch; readonly kind: "session-limit" }
  | {
      readonly approvalBatches: readonly PendingInputBatch[];
      readonly batches: readonly PendingInputBatch[];
      readonly kind: "approval";
      readonly questionBatches: readonly PendingInputBatch[];
    }
  | { readonly batches: readonly PendingInputBatch[]; readonly kind: "question" };

type PendingInputBatchDomain = "approval" | "question" | "session-limit";

type InputDomainResolverInput = {
  readonly baseHistory: ModelMessage[];
  readonly batches: readonly PendingInputBatch[];
  readonly deferTurnInput: boolean;
  readonly resolvedStepInput: ResolvedStepInput | undefined;
  readonly responses: readonly InputResponse[];
  readonly session: HarnessSession;
};

/** Selects the one domain that owns this delivery without mutating session state. */
function routePendingInput(batches: readonly PendingInputBatch[]): PendingInputRoute {
  const classified = batches.map((batch) => ({ batch, domain: classifyPendingInputBatch(batch) }));
  const limitBatch = classified.find(({ domain }) => domain === "session-limit")?.batch;
  if (limitBatch !== undefined) {
    return { batch: limitBatch, kind: "session-limit" };
  }

  const approvalBatches = classified
    .filter(({ domain }) => domain === "approval")
    .map(({ batch }) => batch);
  if (approvalBatches.length > 0) {
    return {
      approvalBatches,
      batches,
      kind: "approval",
      questionBatches: classified
        .filter(({ domain }) => domain === "question")
        .map(({ batch }) => batch),
    };
  }

  return { batches, kind: "question" };
}

function classifyPendingInputBatch(batch: PendingInputBatch): PendingInputBatchDomain {
  let hasApproval = false;
  let hasQuestion = false;
  let hasSessionLimit = false;

  for (const request of batch.requests) {
    switch (request.kind) {
      case "tool-approval":
        hasApproval = true;
        break;
      case "question":
        hasQuestion = true;
        break;
      case "session-limit":
        hasSessionLimit = true;
        break;
      default: {
        const unhandled: never = request.kind;
        throw new TypeError(`Unhandled pending input request kind: ${String(unhandled)}`);
      }
    }
  }

  if (hasSessionLimit) {
    if (hasApproval || hasQuestion) {
      throw new TypeError(SESSION_LIMIT_BATCH_INVARIANT_MESSAGE);
    }
    return "session-limit";
  }

  return hasApproval ? "approval" : "question";
}

function resolveSessionLimitInput(
  input: InputDomainResolverInput & {
    readonly pendingBatch: PendingInputBatch;
  },
): ResolvePendingInputResult {
  const responseIds = new Set(input.responses.map((response) => response.requestId));
  const answered =
    input.pendingBatch.requests.some((request) => responseIds.has(request.requestId)) &&
    input.pendingBatch.requests.every((request) => responseIds.has(request.requestId));
  if (!answered) {
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
    batch.requests.some((request) => isSessionLimitContinuationRequest(request)),
  );
  const messages = [...input.baseHistory];
  appendResolvedBatchTranscript(messages, input.pendingBatch, []);
  const session = removePendingInputBatches(input.session, [input.pendingBatch]);
  const limitContinuation = resolveSessionLimitContinuation({
    requests: input.pendingBatch.requests,
    responses: input.responses,
  });

  return finishResolvedInput({
    deferTurnInput: input.deferTurnInput || limitBlocked,
    leftoverResponses,
    limitContinuation,
    messages,
    resolvedStepInput: input.resolvedStepInput,
    session,
  });
}

function resolveApprovalInputBatches(
  input: InputDomainResolverInput & {
    readonly approvalBatches: readonly PendingInputBatch[];
    readonly questionBatches: readonly PendingInputBatch[];
    readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  },
): ResolvePendingInputResult {
  const responseIds = new Set(input.responses.map((response) => response.requestId));
  const answeredApprovalBatches = new Set(
    input.approvalBatches.filter((batch) =>
      batch.requests.every(
        (request) => !isApprovalRequest(request) || responseIds.has(request.requestId),
      ),
    ),
  );
  const answeredQuestionBatches = new Set(
    findAnsweredQuestionBatches(input.questionBatches, input.responses),
  );
  let resolvedBatches = input.batches.filter(
    (batch) => answeredApprovalBatches.has(batch) || answeredQuestionBatches.has(batch),
  );
  const firstApprovalIndex = resolvedBatches.findIndex((batch) =>
    batch.requests.some((request) => isApprovalRequest(request)),
  );
  if (firstApprovalIndex >= 0) {
    // Anything after this batch would hide its approval response from AI
    // SDK's tail-tool-message scan. Its responses replay on the next step.
    resolvedBatches = resolvedBatches.slice(0, firstApprovalIndex + 1);
  }

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

    // The message runs as an ordinary turn; every batch stays open and
    // answerable. Stray partial responses wait in the deferred input.
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

  const approvalBatch = resolvedBatches.find((batch) =>
    batch.requests.some((request) => isApprovalRequest(request)),
  );
  const questionBatches = resolvedBatches.filter((batch) => batch !== approvalBatch);
  const questions = resolveQuestionBatches({
    batches: questionBatches,
    messages: [...input.baseHistory],
    responses: input.responses,
  });
  const approval =
    approvalBatch === undefined
      ? { messages: questions, session: input.session }
      : resolveApprovalBatch({
          batch: approvalBatch,
          messages: questions,
          resolveApprovalKey: input.resolveApprovalKey,
          responses: input.responses,
          session: input.session,
        });

  return finishResolvedInput({
    deferTurnInput: approvalBatch !== undefined || input.deferTurnInput,
    leftoverResponses,
    messages: approval.messages,
    rejectedActions: approval.rejectedActions,
    resolvedStepInput: input.resolvedStepInput,
    session: removePendingInputBatches(approval.session, resolvedBatches),
  });
}

function resolveApprovalBatch(input: {
  readonly batch: PendingInputBatch;
  readonly messages: ModelMessage[];
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly responses: readonly InputResponse[];
  readonly session: HarnessSession;
}): ResolvedApprovalBatch {
  const sessionWithApprovals = recordApprovedTools({
    pendingBatch: input.batch,
    resolveApprovalKey: input.resolveApprovalKey,
    responses: input.responses,
    session: input.session,
  });
  const toolParts = buildApprovalBatchToolResponseParts(input.batch, input.responses);
  appendResolvedBatchTranscript(input.messages, input.batch, toolParts);
  const rejected = buildRejectedActionBatch(input.batch, input.responses);

  return {
    messages: input.messages,
    rejectedActions: rejected === undefined ? undefined : [rejected],
    session: sessionWithApprovals,
  };
}

function resolveQuestionOnlyInputBatches(
  input: InputDomainResolverInput,
): ResolvePendingInputResult {
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

    // A follow-up message behind one question-only batch marks its unanswered
    // requests ignored so the model can continue with the message.
    const resolved = resolveQuestionBatches({
      batches: [sole],
      messages: [...input.baseHistory],
      responses: [],
    });
    return {
      consumedMessage: input.resolvedStepInput.messageConsumed,
      outcome: "resolved",
      messages: resolved,
      session: removePendingInputBatches(input.session, [sole]),
    };
  }

  const resolved = resolveQuestionBatches({
    batches: resolvedBatches,
    messages: [...input.baseHistory],
    responses: input.responses,
  });

  return finishResolvedInput({
    deferTurnInput: input.deferTurnInput,
    leftoverResponses,
    messages: resolved,
    resolvedStepInput: input.resolvedStepInput,
    session: removePendingInputBatches(input.session, resolvedBatches),
  });
}

type ResolvedStepInput = StepInput & { readonly messageConsumed?: boolean };

function findAnsweredQuestionBatches(
  batches: readonly PendingInputBatch[],
  responses: readonly InputResponse[],
): PendingInputBatch[] {
  const responseIds = new Set(responses.map((response) => response.requestId));
  return batches.filter((batch) =>
    batch.requests.some((request) => responseIds.has(request.requestId)),
  );
}

function responsesForBatches(
  responses: readonly InputResponse[],
  batches: readonly PendingInputBatch[],
): readonly InputResponse[] {
  return responses.filter((response) =>
    batches.some((batch) =>
      batch.requests.some((request) => request.requestId === response.requestId),
    ),
  );
}

type ResolvedApprovalBatch = {
  readonly messages: ModelMessage[];
  readonly rejectedActions?: readonly RejectedActionBatch[];
  readonly session: HarnessSession;
};

function resolveQuestionBatches(input: {
  readonly batches: readonly PendingInputBatch[];
  readonly messages: ModelMessage[];
  readonly responses: readonly InputResponse[];
}): ModelMessage[] {
  const responseMap = new Map(input.responses.map((response) => [response.requestId, response]));
  for (const batch of input.batches) {
    const toolParts = batch.requests.map((request) =>
      buildQuestionToolResponsePart(
        request as QuestionInputRequest,
        responseMap.get(request.requestId),
      ),
    );
    appendResolvedBatchTranscript(input.messages, batch, toolParts);
  }

  return input.messages;
}

function finishResolvedInput(input: {
  readonly deferTurnInput: boolean;
  readonly leftoverResponses: readonly InputResponse[];
  readonly limitContinuation?: { readonly granted: boolean };
  readonly messages: ModelMessage[];
  readonly rejectedActions?: readonly RejectedActionBatch[];
  readonly resolvedStepInput: ResolvedStepInput | undefined;
  readonly session: HarnessSession;
}): ResolvePendingInputResult {
  // AI SDK collects approval responses only from the tail tool message.
  // Defer channel context and any follow-up message so the approval resolves
  // in isolation; `consumeDeferredStepInput` replays them on the next step.
  // A message behind a still-open session-limit prompt defers the same way.
  const deferredInput: {
    context?: StepInput["context"];
    inputResponses?: StepInput["inputResponses"];
    message?: StepInput["message"];
  } = {};
  if (input.leftoverResponses.length > 0) {
    deferredInput.inputResponses = input.leftoverResponses;
  }
  if (input.deferTurnInput) {
    if ((input.resolvedStepInput?.context?.length ?? 0) > 0) {
      deferredInput.context = input.resolvedStepInput?.context;
    }
    if (input.resolvedStepInput?.message !== undefined) {
      deferredInput.message = input.resolvedStepInput.message;
    }
  }

  if (Object.keys(deferredInput).length > 0) {
    const session = queueDeferredStepInput(input.session, deferredInput);

    return {
      consumedMessage: input.resolvedStepInput?.messageConsumed,
      deferredContext: deferredInput.context === undefined ? undefined : true,
      deferredMessage: deferredInput.message === undefined ? undefined : true,
      limitContinuation: input.limitContinuation,
      outcome: "resolved",
      messages: input.messages,
      rejectedActions: input.rejectedActions,
      session,
    };
  }

  return {
    consumedMessage: input.resolvedStepInput?.messageConsumed,
    limitContinuation: input.limitContinuation,
    outcome: "resolved",
    messages: input.messages,
    rejectedActions: input.rejectedActions,
    session: input.session,
  };
}

function appendResolvedBatchTranscript(
  messages: ModelMessage[],
  batch: PendingInputBatch,
  toolParts: readonly ToolResponsePart[],
): void {
  messages.push(...batch.responseMessages);
  if (toolParts.length > 0) {
    messages.push({ content: [...toolParts], role: "tool" });
  }
}

function canonicalizeInputResponses(responses: readonly InputResponse[]): readonly InputResponse[] {
  const byRequestId = new Map<string, InputResponse>();
  for (const response of responses) {
    byRequestId.set(response.requestId, response);
  }
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
): (StepInput & { readonly messageConsumed?: boolean }) | undefined {
  if (typeof stepInput?.message !== "string") {
    return stepInput;
  }

  const batchRequestIds = new Set(pendingBatch.requests.map((request) => request.requestId));
  if (stepInput.inputResponses?.some((response) => batchRequestIds.has(response.requestId))) {
    return stepInput;
  }

  const responses = resolveTextToResponses(stepInput.message, pendingBatch.requests);
  if (responses.length === 0) {
    return stepInput;
  }

  return compactStepInput({
    ...stepInput,
    inputResponses: [...(stepInput.inputResponses ?? []), ...responses],
    messageConsumed: true,
    message: undefined,
  });
}

function compactStepInput(
  input: (StepInput & { readonly messageConsumed?: boolean }) | undefined,
): StepInput & { readonly messageConsumed?: boolean } {
  if (input === undefined) {
    return {};
  }

  const result: {
    context?: StepInput["context"];
    inputResponses?: StepInput["inputResponses"];
    message?: StepInput["message"];
    messageConsumed?: boolean;
    outputSchema?: StepInput["outputSchema"];
  } = {};

  if ((input.context?.length ?? 0) > 0) {
    result.context = input.context;
  }
  if ((input.inputResponses?.length ?? 0) > 0) {
    result.inputResponses = input.inputResponses;
  }
  if (input.message !== undefined) {
    result.message = input.message;
  }
  if (input.messageConsumed === true) {
    result.messageConsumed = true;
  }
  if (input.outputSchema !== undefined) {
    result.outputSchema = input.outputSchema;
  }

  return result;
}

/**
 * Drops a pending session-limit continuation prompt from a parked session.
 *
 * A cancelled turn settles with the step's input snapshot, which can
 * resurrect a continuation prompt the user already answered — the decline
 * that cancelled the turn consumed the answer inside the discarded turn
 * state. Left in place, the stale prompt would queue every follow-up
 * message behind an answer that will never come. Harness-authored prompts
 * are deterministically re-raised by the pre-model gate, so dropping is
 * always safe; model-anchored batches (tool approvals, questions) are kept
 * because their tool calls still require resolution.
 */
export function clearPendingSessionLimitPrompt(session: HarnessSession): HarnessSession {
  const dropped = getPendingInputBatches(session.state).filter(
    (batch) =>
      batch.requests.length > 0 &&
      batch.requests.every((request) => isSessionLimitContinuationRequest(request)),
  );
  if (dropped.length === 0) {
    return session;
  }
  return removePendingInputBatches(session, dropped);
}

type ResolvePendingInputResult = {
  readonly consumedMessage?: boolean;
  readonly deferredContext?: boolean;
  readonly deferredMessage?: boolean;
  /**
   * Present when a resolved batch answered a session-limit continuation
   * prompt. The tool loop grants a fresh token budget window or terminates
   * the session based on `granted`.
   */
  readonly limitContinuation?: { readonly granted: boolean };
  readonly outcome: "resolved" | "continue" | "unresolved";
  readonly messages: ModelMessage[];
  readonly rejectedActions?: readonly RejectedActionBatch[];
  readonly session: HarnessSession;
};

// ---------------------------------------------------------------------------
// Approval tracking
// ---------------------------------------------------------------------------

/**
 * Returns the set of tool names that have been approved at least once
 * during this session.
 */
export function getApprovedTools(session: HarnessSession): ReadonlySet<string> {
  const value = session.state?.[APPROVED_TOOLS_KEY];

  if (!Array.isArray(value)) {
    return new Set();
  }

  return new Set(value as string[]);
}

/**
 * Resolves the approval key for a request. When a `resolveApprovalKey`
 * function is provided and returns a string, that compound key is recorded
 * instead of the bare tool name.
 */
function recordApprovedTools(input: {
  readonly pendingBatch: PendingInputBatch;
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly responses: readonly InputResponse[];
  readonly session: HarnessSession;
}): HarnessSession {
  const approvedIds = new Set(
    input.responses.filter((r) => r.optionId === "approve").map((r) => r.requestId),
  );

  const newKeys = input.pendingBatch.requests
    .filter((r) => isApprovalRequest(r) && approvedIds.has(r.requestId))
    .map((r) => input.resolveApprovalKey?.(r) ?? r.action.toolName);

  if (newKeys.length === 0) {
    return input.session;
  }

  const existing = getApprovedTools(input.session);
  const combined = [...new Set([...existing, ...newKeys])];
  const state = { ...input.session.state };
  state[APPROVED_TOOLS_KEY] = combined;

  return { ...input.session, state };
}

// ---------------------------------------------------------------------------
// Tool response building
// ---------------------------------------------------------------------------

/**
 * Resolves whether an approval request was granted and, when auto-denied
 * because the user continued without responding, the reason to record.
 */
function resolveApprovalOutcome(response: InputResponse | undefined): {
  readonly approved: boolean;
  readonly reason: string | undefined;
  readonly status: ApprovalTerminalStatus;
} {
  if (response === undefined) {
    return {
      approved: false,
      reason: IGNORED_INPUT_REASON,
      status: "ignored",
    };
  }

  if (response.optionId === "approve") {
    return {
      approved: true,
      reason: undefined,
      status: "approved",
    };
  }

  if (response.optionId === "cancel") {
    return {
      approved: false,
      reason: TOOL_EXECUTION_DENIED_MESSAGE,
      status: "denied",
    };
  }

  return {
    approved: false,
    reason: TOOL_EXECUTION_INVALID_APPROVAL_MESSAGE,
    status: "invalid",
  };
}

/**
 * Builds one rejected `action.result` payload per denied tool-call approval so
 * the stream records denials that otherwise live only in model history.
 */
function buildRejectedActionBatch(
  batch: PendingInputBatch,
  responses: readonly InputResponse[],
): RejectedActionBatch | undefined {
  if (batch.event === undefined) {
    return undefined;
  }

  const responseMap = new Map(responses.map((r) => [r.requestId, r]));
  const results: RuntimeToolResultActionResult[] = [];
  for (const request of batch.requests) {
    if (!isApprovalRequest(request)) {
      continue;
    }

    const { approved, reason, status } = resolveApprovalOutcome(responseMap.get(request.requestId));
    if (approved) {
      continue;
    }

    results.push({
      callId: request.action.callId,
      isError: true,
      kind: "tool-result",
      output: {
        approval: {
          requestId: request.requestId,
          status,
        },
        code: TOOL_EXECUTION_DENIED_CODE,
        message: reason ?? TOOL_EXECUTION_DENIED_MESSAGE,
        tool: {
          result: "not_run",
        },
      },
      toolName: request.action.toolName,
    });
  }

  return results.length > 0 ? { event: batch.event, results } : undefined;
}

type QuestionInputRequest = InputRequest & { readonly kind: "question" };
type ToolApprovalInputRequest = InputRequest & { readonly kind: "tool-approval" };

function buildApprovalBatchToolResponseParts(
  batch: PendingInputBatch,
  responses: readonly InputResponse[],
): ToolResponsePart[] {
  const responseMap = new Map(responses.map((r) => [r.requestId, r]));

  const parts: ToolResponsePart[] = [];
  for (const request of batch.requests) {
    const response = responseMap.get(request.requestId);
    switch (request.kind) {
      case "tool-approval":
        parts.push(
          ...buildApprovalToolResponseParts(request as ToolApprovalInputRequest, response),
        );
        break;
      case "question":
        parts.push(buildQuestionToolResponsePart(request as QuestionInputRequest, response));
        break;
      case "session-limit":
        throw new TypeError(SESSION_LIMIT_BATCH_INVARIANT_MESSAGE);
      default: {
        const unhandled: never = request.kind;
        throw new TypeError(`Unhandled pending input request kind: ${String(unhandled)}`);
      }
    }
  }
  return parts;
}

function buildApprovalToolResponseParts(
  request: ToolApprovalInputRequest,
  response: InputResponse | undefined,
): ToolResponsePart[] {
  const { approved, reason } = resolveApprovalOutcome(response);
  const parts: ToolResponsePart[] = [
    {
      approvalId: request.requestId,
      approved,
      reason,
      type: "tool-approval-response",
    },
  ];
  /*
   * On denial (explicit "cancel" or auto-deny when the user continues
   * without responding), splice in the matching `execution-denied`
   * tool-result. AI SDK's `streamText` synthesizes this for the
   * current turn's `initialResponseMessages`, but that synthesis is
   * gated on the input messages' last entry being a tool message —
   * on subsequent turns (when a new user message is the tail of
   * history) the synthesis is skipped, and the persisted
   * `tool-approval-response` is stripped during provider prompt
   * conversion. Without an own `tool-result` in history, the prior
   * `tool_use` block replays unmatched and some providers reject
   * the request with 400.
   */
  if (!approved) {
    parts.push({
      output: { type: "execution-denied", reason },
      toolCallId: request.action.callId,
      toolName: request.action.toolName,
      type: "tool-result",
    });
  }
  return parts;
}

function buildQuestionToolResponsePart(
  request: QuestionInputRequest,
  response: InputResponse | undefined,
): ToolResponsePart {
  return {
    output: {
      type: "json",
      value:
        response !== undefined
          ? { optionId: response.optionId, text: response.text, status: "answered" }
          : { status: "ignored" },
    },
    toolCallId: request.action.callId,
    toolName: request.action.toolName,
    type: "tool-result",
  };
}

// ---------------------------------------------------------------------------
// Tool call helpers
// ---------------------------------------------------------------------------

/**
 * Creates a runtime tool-call action shape from an AI SDK tool call.
 */
export function createRuntimeToolCallActionFromToolCall(input: {
  readonly toolCall: {
    readonly input: unknown;
    readonly toolCallId: string;
    readonly toolName: string;
  };
}): RuntimeToolCallActionRequest {
  return {
    callId: input.toolCall.toolCallId,
    input: resolveToolCallInputObject(input.toolCall.input, {
      callId: input.toolCall.toolCallId,
      toolName: input.toolCall.toolName,
    }),
    kind: "tool-call",
    toolName: input.toolCall.toolName,
  };
}
