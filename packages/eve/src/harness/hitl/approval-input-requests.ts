import type { ModelMessage } from "ai";

import type { RuntimeToolResultActionResult } from "#runtime/actions/types.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import {
  queueDeferredStepInput,
  removePendingInputBatches,
} from "#harness/pending-input-batches.js";
import {
  appendResolvedBatchTranscript,
  compactStepInput,
  finishResolvedInput,
  responsesForBatches,
} from "#harness/hitl/pending-input-resolution.js";
import type {
  InputDomainResolverInput,
  ResolvedInputActionBatch,
  ResolvePendingInputResult,
  ToolResponsePart,
} from "#harness/hitl/pending-input-resolution.js";
import {
  buildQuestionToolResponsePart,
  findAnsweredQuestionBatches,
  resolveQuestionBatches,
} from "#harness/hitl/question-input-requests.js";
import type { QuestionInputRequest } from "#harness/hitl/question-input-requests.js";
import type { HarnessSession } from "#harness/types.js";

const APPROVED_TOOLS_KEY = "eve.runtime.hitl.approvedTools";
const IGNORED_INPUT_REASON = "Ignored because the user continued without responding.";
const TOOL_EXECUTION_DENIED_CODE = "TOOL_EXECUTION_DENIED";
const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution was denied.";
const TOOL_EXECUTION_INVALID_APPROVAL_MESSAGE = "Invalid approval response.";

type ApprovalTerminalStatus = "approved" | "denied" | "ignored" | "invalid";
type ToolApprovalInputRequest = InputRequest & { readonly kind: "tool-approval" };

export type RejectedActionBatch = ResolvedInputActionBatch;

export function hasAnsweredApprovalBatch(
  batches: readonly PendingInputBatch[],
  responses: readonly InputResponse[],
): boolean {
  const responseIds = new Set(responses.map((response) => response.requestId));
  return batches.some((batch) =>
    batch.requests.every(
      (request) => !isApprovalRequest(request) || responseIds.has(request.requestId),
    ),
  );
}

export function resolveApprovalInputBatches(
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

/** Returns tool approval keys recorded during this session. */
export function getApprovedTools(session: HarnessSession): ReadonlySet<string> {
  const value = session.state?.[APPROVED_TOOLS_KEY];
  return Array.isArray(value) ? new Set(value as string[]) : new Set();
}

function resolveApprovalBatch(input: {
  readonly batch: PendingInputBatch;
  readonly messages: ModelMessage[];
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly responses: readonly InputResponse[];
  readonly session: HarnessSession;
}): ResolvedApprovalBatch {
  const session = recordApprovedTools({
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
    session,
  };
}

type ResolvedApprovalBatch = {
  readonly messages: ModelMessage[];
  readonly rejectedActions?: readonly RejectedActionBatch[];
  readonly session: HarnessSession;
};

function recordApprovedTools(input: {
  readonly pendingBatch: PendingInputBatch;
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly responses: readonly InputResponse[];
  readonly session: HarnessSession;
}): HarnessSession {
  const approvedIds = new Set(
    input.responses.filter((response) => response.optionId === "approve").map((r) => r.requestId),
  );
  const newKeys = input.pendingBatch.requests
    .filter((request) => isApprovalRequest(request) && approvedIds.has(request.requestId))
    .map((request) => input.resolveApprovalKey?.(request) ?? request.action.toolName);

  if (newKeys.length === 0) return input.session;

  const state = { ...input.session.state };
  state[APPROVED_TOOLS_KEY] = [...new Set([...getApprovedTools(input.session), ...newKeys])];
  return { ...input.session, state };
}

function resolveApprovalOutcome(response: InputResponse | undefined): {
  readonly approved: boolean;
  readonly reason: string | undefined;
  readonly status: ApprovalTerminalStatus;
} {
  if (response === undefined) {
    return { approved: false, reason: IGNORED_INPUT_REASON, status: "ignored" };
  }
  if (response.optionId === "approve") {
    return { approved: true, reason: undefined, status: "approved" };
  }
  if (response.optionId === "cancel") {
    return { approved: false, reason: TOOL_EXECUTION_DENIED_MESSAGE, status: "denied" };
  }
  return {
    approved: false,
    reason: TOOL_EXECUTION_INVALID_APPROVAL_MESSAGE,
    status: "invalid",
  };
}

function buildRejectedActionBatch(
  batch: PendingInputBatch,
  responses: readonly InputResponse[],
): RejectedActionBatch | undefined {
  if (batch.event === undefined) return undefined;

  const responseMap = new Map(responses.map((response) => [response.requestId, response]));
  const results: RuntimeToolResultActionResult[] = [];
  for (const request of batch.requests) {
    if (!isApprovalRequest(request)) continue;

    const { approved, reason, status } = resolveApprovalOutcome(responseMap.get(request.requestId));
    if (approved) continue;

    results.push({
      callId: request.action.callId,
      isError: true,
      kind: "tool-result",
      output: {
        approval: { requestId: request.requestId, status },
        code: TOOL_EXECUTION_DENIED_CODE,
        message: reason ?? TOOL_EXECUTION_DENIED_MESSAGE,
        tool: { result: "not_run" },
      },
      toolName: request.action.toolName,
    });
  }

  return results.length > 0 ? { event: batch.event, results } : undefined;
}

function buildApprovalBatchToolResponseParts(
  batch: PendingInputBatch,
  responses: readonly InputResponse[],
): ToolResponsePart[] {
  const responseMap = new Map(responses.map((response) => [response.requestId, response]));
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
        throw new TypeError(
          "Session-limit pending input batches must contain only session-limit requests.",
        );
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
    { approvalId: request.requestId, approved, reason, type: "tool-approval-response" },
  ];
  // Persist an explicit denial result because AI SDK strips historical
  // approval responses during provider prompt conversion.
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
