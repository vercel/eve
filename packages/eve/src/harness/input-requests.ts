import type { ModelMessage, ToolSet, TypedToolCall } from "ai";

import type {
  RuntimeToolCallActionRequest,
  RuntimeToolResultActionResult,
} from "#runtime/actions/types.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import { resolveTextToResponses } from "#channel/resolve-text.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import {
  isSessionLimitContinuationRequest,
  resolveSessionLimitContinuation,
} from "#harness/session-limit-continuation.js";
import type { HarnessSession, SessionStateMap, StepInput } from "#harness/types.js";

const PENDING_INPUT_BATCH_KEY = "eve.runtime.pendingInputBatch";
const APPROVED_TOOLS_KEY = "eve.runtime.hitl.approvedTools";
const DEFERRED_STEP_INPUT_KEY = "eve.runtime.deferredStepInput";

const IGNORED_INPUT_REASON = "Ignored because the user continued without responding.";

const TOOL_EXECUTION_DENIED_CODE = "TOOL_EXECUTION_DENIED";
const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution was denied.";
const TOOL_EXECUTION_INVALID_APPROVAL_MESSAGE = "Invalid approval response.";

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];

/**
 * Stream-emit coordinates carried so a parked batch's resolution can attribute
 * its events to the turn and step that requested the input.
 */
interface PendingInputBatchEvent {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/**
 * Serializable pending input batch stored on the session state.
 */
interface PendingInputBatch {
  readonly event?: PendingInputBatchEvent;
  readonly requests: readonly InputRequest[];
  readonly responseMessages: readonly ModelMessage[];
}

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
// Deferred step input
// ---------------------------------------------------------------------------

/**
 * Merges any queued follow-up input into the current step input and clears it
 * from session state.
 *
 * Used when the harness has to process a pending tool-approval response first
 * and defer the user's new message to the next internal model step.
 */
export function consumeDeferredStepInput(input: {
  readonly input?: StepInput;
  readonly session: HarnessSession;
}): {
  readonly input?: StepInput;
  readonly session: HarnessSession;
} {
  const deferredInput = getDeferredStepInput(input.session);

  if (deferredInput === undefined) {
    return input;
  }

  const session = clearDeferredStepInput(input.session);

  if (input.input === undefined) {
    return {
      input: deferredInput,
      session,
    };
  }

  return {
    input: coalesceTurnInputs(deferredInput, input.input),
    session,
  };
}

/**
 * Returns true when the session carries queued follow-up input for the next
 * internal harness step.
 */
export function hasDeferredStepInput(session: HarnessSession): boolean {
  return getDeferredStepInput(session) !== undefined;
}

// ---------------------------------------------------------------------------
// Pending input resolution
// ---------------------------------------------------------------------------

/**
 * Resolves pending input at the start of a harness step.
 *
 * When the pending batch contains tool-approval requests and the step input
 * also carries a follow-up user message, the message is deferred to the next
 * internal harness step rather than appended to the current turn. This is
 * necessary because AI SDK cannot process tool-approval responses and a new
 * user message in the same request -- the approval must be resolved in
 * isolation first, and the user message replayed on the subsequent step via
 * {@link consumeDeferredStepInput}.
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

  const pendingBatch = getPendingInputBatch(session.state);

  // No pending batch -- pass through to the model call.
  if (pendingBatch === undefined) {
    return { outcome: "continue", messages: baseHistory, session };
  }

  // Pending batch exists -- only resolve if we have actual responses.
  const resolvedStepInput = resolveTextMessageInput(pendingBatch, stepInput);
  const responses = resolvedStepInput?.inputResponses ?? [];
  const resolvesApprovalBatch = pendingBatch.requests.some((request) => isApprovalRequest(request));

  if (responses.length === 0 && resolvedStepInput?.message === undefined) {
    return { outcome: "unresolved", messages: baseHistory, session };
  }

  if (resolvesApprovalBatch && hasUnansweredApproval({ pendingBatch, responses })) {
    session = queueDeferredStepInput(session, compactStepInput(resolvedStepInput));
    return { deferredMessage: true, outcome: "unresolved", messages: baseHistory, session };
  }

  if (responses.length === 0 && resolvedStepInput?.message !== undefined) {
    // A follow-up message arrived for question-only input with no explicit
    // responses. Keep the existing question semantics: mark unanswered
    // question requests ignored so the model can continue with the message.
    const toolParts = buildToolResponseParts(pendingBatch, []);
    const messages: ModelMessage[] = [...baseHistory, ...pendingBatch.responseMessages];
    if (toolParts.length > 0) {
      messages.push({ content: toolParts, role: "tool" });
    }

    const rejectedActions = buildRejectedActionBatch(pendingBatch, []);
    session = clearPendingInputBatch(session);

    return {
      consumedMessage: resolvedStepInput?.messageConsumed,
      outcome: "resolved",
      messages,
      rejectedActions,
      session,
    };
  }

  const limitContinuation = resolveSessionLimitContinuation({
    requests: pendingBatch.requests,
    responses,
  });

  // Record approved tools before clearing the batch.
  session = recordApprovedTools({
    pendingBatch,
    resolveApprovalKey: input.resolveApprovalKey,
    responses,
    session,
  });

  // Build tool result messages from responses.
  const toolParts = buildToolResponseParts(pendingBatch, responses);

  const messages: ModelMessage[] = [...baseHistory, ...pendingBatch.responseMessages];
  if (toolParts.length > 0) {
    messages.push({ content: toolParts, role: "tool" });
  }

  const rejectedActions = buildRejectedActionBatch(pendingBatch, responses);
  session = clearPendingInputBatch(session);

  // AI SDK collects approval responses only from the tail tool message.
  // Defer channel context and any follow-up message so the approval resolves
  // in isolation; `consumeDeferredStepInput` replays them on the next step.
  if (resolvesApprovalBatch) {
    const deferredInput: {
      context?: StepInput["context"];
      message?: StepInput["message"];
    } = {};
    if ((resolvedStepInput?.context?.length ?? 0) > 0) {
      deferredInput.context = resolvedStepInput?.context;
    }
    if (resolvedStepInput?.message !== undefined) {
      deferredInput.message = resolvedStepInput.message;
    }

    if (deferredInput.context !== undefined || deferredInput.message !== undefined) {
      session = queueDeferredStepInput(session, deferredInput);

      return {
        consumedMessage: resolvedStepInput?.messageConsumed,
        deferredContext: deferredInput.context === undefined ? undefined : true,
        deferredMessage: deferredInput.message === undefined ? undefined : true,
        limitContinuation,
        outcome: "resolved",
        messages,
        rejectedActions,
        session,
      };
    }
  }

  return {
    consumedMessage: resolvedStepInput?.messageConsumed,
    limitContinuation,
    outcome: "resolved",
    messages,
    rejectedActions,
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

function hasUnansweredApproval(input: {
  readonly pendingBatch: PendingInputBatch;
  readonly responses: readonly InputResponse[];
}): boolean {
  const responseIds = new Set(input.responses.map((response) => response.requestId));
  return input.pendingBatch.requests.some(
    (request) => isApprovalRequest(request) && !responseIds.has(request.requestId),
  );
}

type ResolvePendingInputResult = {
  readonly consumedMessage?: boolean;
  readonly deferredContext?: boolean;
  readonly deferredMessage?: boolean;
  /**
   * Present when the resolved batch answered a session-limit continuation
   * prompt. The tool loop grants a fresh token budget window or terminates
   * the session based on `granted`.
   */
  readonly limitContinuation?: { readonly granted: boolean };
  readonly outcome: "resolved" | "continue" | "unresolved";
  readonly messages: ModelMessage[];
  readonly rejectedActions?: RejectedActionBatch;
  readonly session: HarnessSession;
};

// ---------------------------------------------------------------------------
// Pending batch management
// ---------------------------------------------------------------------------

/**
 * Returns true when the session is parked on a pending HITL batch
 * (tool approvals or `ask_question` prompts).
 */
export function hasPendingInputBatch(state: SessionStateMap | undefined): boolean {
  return getPendingInputBatch(state) !== undefined;
}

function getPendingInputBatch(state: SessionStateMap | undefined): PendingInputBatch | undefined {
  const value = state?.[PENDING_INPUT_BATCH_KEY];

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const batch = value as PendingInputBatch;

  if (!Array.isArray(batch.requests) || !Array.isArray(batch.responseMessages)) {
    return undefined;
  }

  return batch;
}

/**
 * Stores one pending HITL batch on the session until the user responds.
 */
export function setPendingInputBatch(input: {
  readonly event?: PendingInputBatchEvent;
  readonly requests: readonly InputRequest[];
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  const state = { ...input.session.state };
  state[PENDING_INPUT_BATCH_KEY] = {
    event: input.event,
    requests: [...input.requests],
    responseMessages: [...input.responseMessages],
  } satisfies PendingInputBatch;

  return { ...input.session, state };
}

function clearPendingInputBatch(session: HarnessSession): HarnessSession {
  if (session.state?.[PENDING_INPUT_BATCH_KEY] === undefined) {
    return session;
  }

  const state = { ...session.state };
  delete state[PENDING_INPUT_BATCH_KEY];

  return { ...session, state: Object.keys(state).length > 0 ? state : undefined };
}

// ---------------------------------------------------------------------------
// Deferred step input state
// ---------------------------------------------------------------------------

function getDeferredStepInput(session: HarnessSession): StepInput | undefined {
  return session.state?.[DEFERRED_STEP_INPUT_KEY] as StepInput | undefined;
}

function queueDeferredStepInput(session: HarnessSession, input: StepInput): HarnessSession {
  const existing = getDeferredStepInput(session);
  const deferredInput = existing === undefined ? input : coalesceTurnInputs(existing, input);
  const state = { ...session.state };
  state[DEFERRED_STEP_INPUT_KEY] = deferredInput;

  return {
    ...session,
    state,
  };
}

function clearDeferredStepInput(session: HarnessSession): HarnessSession {
  if (session.state?.[DEFERRED_STEP_INPUT_KEY] === undefined) {
    return session;
  }

  const state = { ...session.state };
  delete state[DEFERRED_STEP_INPUT_KEY];

  return {
    ...session,
    state: Object.keys(state).length > 0 ? state : undefined,
  };
}

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

  if (response.optionId === "deny") {
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
     * On denial (explicit "deny" or auto-deny when the user continues
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

function isApprovalRequest(request: InputRequest): boolean {
  return (
    request.options?.length === 2 &&
    request.options[0]?.id === "approve" &&
    request.options[1]?.id === "deny"
  );
}

// ---------------------------------------------------------------------------
// Tool call helpers
// ---------------------------------------------------------------------------

/**
 * Creates a runtime tool-call action shape from an AI SDK tool call.
 */
export function createRuntimeToolCallActionFromToolCall(input: {
  readonly toolCall: TypedToolCall<ToolSet>;
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

function resolveToolCallInputObject(
  value: unknown,
  context: { readonly callId: string; readonly toolName: string },
): JsonObject {
  if (value === undefined || value === null) {
    return {};
  }

  try {
    return parseJsonObject(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(
      `Failed to parse tool-call arguments for "${context.toolName}" (${context.callId}): ${detail}`,
      { cause: error },
    );
  }
}
