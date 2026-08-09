import type { ModelMessage } from "ai";

import type {
  RuntimeToolCallActionRequest,
  RuntimeToolResultActionResult,
} from "#runtime/actions/types.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import { resolveTextToResponses } from "#channel/resolve-text.js";
import { classifyInputRequest, isApprovalRequest } from "#harness/input-request-class.js";
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
 * request in it (see {@link classifyInputRequest}); its withheld model
 * output is then restored behind the current history. Responses that answer
 * only part of a batch wait in the deferred step input until the rest
 * arrives.
 *
 * A plain message never waits behind a tool approval: it runs as an
 * ordinary turn while the approval batch stays open and answerable. Only a
 * session-limit prompt still holds messages back — the budget gate must not
 * run the model. A message behind a single question-only batch keeps its
 * dismiss-and-continue behavior.
 *
 * Tool approval responses additionally resolve in isolation because AI SDK
 * cannot process an approval response and a new user message in the same
 * request; {@link consumeDeferredStepInput} replays the message on the
 * subsequent step.
 */
export function resolvePendingInput(input: {
  readonly history?: readonly ModelMessage[];
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}): ResolvePendingInputResult {
  const { stepInput } = input;
  let session = input.session;
  const baseHistory = [...(input.history ?? session.history)];

  const batches = getPendingInputBatches(session.state);

  // No pending batches -- pass through to the model call.
  if (batches.length === 0) {
    return { outcome: "continue", messages: baseHistory, session };
  }

  // Text matching stays scoped to a single open batch: with several open,
  // a bare option word is ambiguous, so it stays an ordinary message.
  const resolvedStepInput: (StepInput & { readonly messageConsumed?: boolean }) | undefined =
    batches.length === 1 ? resolveTextMessageInput(batches[0]!, stepInput) : stepInput;
  const responses = resolvedStepInput?.inputResponses ?? [];

  if (responses.length === 0 && resolvedStepInput?.message === undefined) {
    return { outcome: "unresolved", messages: baseHistory, session };
  }

  const responseIds = new Set(responses.map((response) => response.requestId));
  const resolvedBatches = batches.filter(
    (batch) =>
      batch.requests.some((request) => responseIds.has(request.requestId)) &&
      !hasUnansweredRequiredRequest({ pendingBatch: batch, responses }),
  );
  const openBatches = batches.filter((batch) => !resolvedBatches.includes(batch));
  const leftoverResponses = responses.filter((response) =>
    openBatches.some((batch) =>
      batch.requests.some((request) => request.requestId === response.requestId),
    ),
  );
  const limitBlocked = openBatches.some((batch) =>
    batch.requests.some((request) => isSessionLimitContinuationRequest(request)),
  );

  if (resolvedBatches.length === 0) {
    if (limitBlocked) {
      // The budget gate owns the session until its prompt is answered.
      session = queueDeferredStepInput(session, compactStepInput(resolvedStepInput));
      return { deferredMessage: true, outcome: "unresolved", messages: baseHistory, session };
    }

    if (resolvedStepInput?.message === undefined) {
      // Partial responses wait for the rest of their batch;
      // `consumeDeferredStepInput` coalesces them with the next delivery.
      session = queueDeferredStepInput(session, compactStepInput(resolvedStepInput));
      return { outcome: "unresolved", messages: baseHistory, session };
    }

    const sole = batches.length === 1 ? batches[0] : undefined;
    if (sole !== undefined && !sole.requests.some((request) => isApprovalRequest(request))) {
      // A follow-up message behind a single question-only batch keeps its
      // pre-collection behavior: mark the unanswered requests ignored so
      // the model can continue with the message.
      const toolParts = buildToolResponseParts(sole, []);
      const messages: ModelMessage[] = [...baseHistory, ...sole.responseMessages];
      if (toolParts.length > 0) {
        messages.push({ content: toolParts, role: "tool" });
      }

      const rejected = buildRejectedActionBatch(sole, []);
      session = removePendingInputBatches(session, [sole]);

      return {
        consumedMessage: resolvedStepInput.messageConsumed,
        outcome: "resolved",
        messages,
        rejectedActions: rejected === undefined ? undefined : [rejected],
        session,
      };
    }

    // The message runs as an ordinary turn; every batch stays open and
    // answerable. Stray partial responses wait in the deferred input.
    if (leftoverResponses.length > 0) {
      session = queueDeferredStepInput(session, { inputResponses: leftoverResponses });
    }
    return {
      consumedMessage: resolvedStepInput.messageConsumed,
      outcome: "continue",
      messages: baseHistory,
      session,
    };
  }

  let limitContinuation: { readonly granted: boolean } | undefined;
  let resolvesApprovalBatch = false;
  const messages: ModelMessage[] = [...baseHistory];
  const rejectedActions: RejectedActionBatch[] = [];

  for (const batch of resolvedBatches) {
    resolvesApprovalBatch ||= batch.requests.some((request) => isApprovalRequest(request));
    limitContinuation ??= resolveSessionLimitContinuation({
      requests: batch.requests,
      responses,
    });

    // Record approved tools before dropping the batch.
    session = recordApprovedTools({
      pendingBatch: batch,
      resolveApprovalKey: input.resolveApprovalKey,
      responses,
      session,
    });

    const toolParts = buildToolResponseParts(batch, responses);
    messages.push(...batch.responseMessages);
    if (toolParts.length > 0) {
      messages.push({ content: toolParts, role: "tool" });
    }

    const rejected = buildRejectedActionBatch(batch, responses);
    if (rejected !== undefined) {
      rejectedActions.push(rejected);
    }
  }

  session = removePendingInputBatches(session, resolvedBatches);

  // AI SDK collects approval responses only from the tail tool message.
  // Defer channel context and any follow-up message so the approval resolves
  // in isolation; `consumeDeferredStepInput` replays them on the next step.
  // A message behind a still-open session-limit prompt defers the same way.
  const deferredInput: {
    context?: StepInput["context"];
    inputResponses?: StepInput["inputResponses"];
    message?: StepInput["message"];
  } = {};
  if (leftoverResponses.length > 0) {
    deferredInput.inputResponses = leftoverResponses;
  }
  if (resolvesApprovalBatch || limitBlocked) {
    if ((resolvedStepInput?.context?.length ?? 0) > 0) {
      deferredInput.context = resolvedStepInput?.context;
    }
    if (resolvedStepInput?.message !== undefined) {
      deferredInput.message = resolvedStepInput.message;
    }
  }

  if (
    deferredInput.context !== undefined ||
    deferredInput.message !== undefined ||
    deferredInput.inputResponses !== undefined
  ) {
    session = queueDeferredStepInput(session, deferredInput);

    return {
      consumedMessage: resolvedStepInput?.messageConsumed,
      deferredContext: deferredInput.context === undefined ? undefined : true,
      deferredMessage: deferredInput.message === undefined ? undefined : true,
      limitContinuation,
      outcome: "resolved",
      messages,
      rejectedActions: rejectedActions.length > 0 ? rejectedActions : undefined,
      session,
    };
  }

  return {
    consumedMessage: resolvedStepInput?.messageConsumed,
    limitContinuation,
    outcome: "resolved",
    messages,
    rejectedActions: rejectedActions.length > 0 ? rejectedActions : undefined,
    session,
  };
}

function resolveTextMessageInput(
  pendingBatch: PendingInputBatch,
  stepInput: StepInput | undefined,
): (StepInput & { readonly messageConsumed?: boolean }) | undefined {
  if (typeof stepInput?.message !== "string" || (stepInput.inputResponses?.length ?? 0) > 0) {
    return stepInput;
  }

  const responses = resolveTextToResponses(stepInput.message, pendingBatch.requests);
  if (responses.length === 0) {
    return stepInput;
  }

  return compactStepInput({
    ...stepInput,
    inputResponses: responses,
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

function hasUnansweredRequiredRequest(input: {
  readonly pendingBatch: PendingInputBatch;
  readonly responses: readonly InputResponse[];
}): boolean {
  const responseIds = new Set(input.responses.map((response) => response.requestId));
  return input.pendingBatch.requests.some(
    (request) =>
      classifyInputRequest(request) === "required" && !responseIds.has(request.requestId),
  );
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
    .filter((r) => approvedIds.has(r.requestId))
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

function buildToolResponseParts(
  batch: PendingInputBatch,
  responses: readonly InputResponse[],
): ToolResponsePart[] {
  const responseMap = new Map(responses.map((r) => [r.requestId, r]));

  const parts: ToolResponsePart[] = [];
  for (const request of batch.requests) {
    parts.push(...buildToolResponsePartsForRequest(request, responseMap.get(request.requestId)));
  }
  return parts;
}

function buildToolResponsePartsForRequest(
  request: InputRequest,
  response: InputResponse | undefined,
): ToolResponsePart[] {
  // A session-limit continuation prompt is harness-authored: no matching
  // tool call exists in model history, so resolving it must not append a
  // tool message the provider would reject as unmatched. This is currently
  // the only harness-authored request type; if another appears, replace this
  // toolName predicate with a generic synthetic-request marker instead of
  // stacking a second special case here.
  if (isSessionLimitContinuationRequest(request)) {
    return [];
  }

  if (isApprovalRequest(request)) {
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

  return [
    {
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
    },
  ];
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
