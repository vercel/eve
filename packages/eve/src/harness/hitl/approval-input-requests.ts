import type { ModelMessage } from "ai";

import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import {
  buildResolvedInputBatch,
  resolveApprovalOutcome,
  TOOL_EXECUTION_DENIED_MESSAGE,
} from "#harness/input-request-resolution.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import {
  getPendingInputBatches,
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
import type { HarnessSession } from "#harness/types.js";
import { validateHarnessModelMessages } from "#harness/messages.js";

const APPROVED_TOOLS_KEY = "eve.runtime.hitl.approvedTools";
const TOOL_EXECUTION_DENIED_CODE = "TOOL_EXECUTION_DENIED";
type ToolApprovalInputRequest = InputRequest & { readonly kind: "tool-approval" };

export type RejectedActionBatch = ResolvedInputActionBatch;

export function findAnsweredApprovalBatches(
  batches: readonly PendingInputBatch[],
  responses: readonly InputResponse[],
): PendingInputBatch[] {
  const responseIds = new Set(responses.map((response) => response.requestId));
  return batches.filter((batch) =>
    batch.requests.every(
      (request) => !isApprovalRequest(request) || responseIds.has(request.requestId),
    ),
  );
}

export function resolveApprovalInputBatches(
  input: InputDomainResolverInput & {
    readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  },
): ResolvePendingInputResult {
  const answered = new Set(findAnsweredApprovalBatches(input.batches, input.responses));
  // Only the first answered batch resolves: anything after it would hide its
  // approval response from AI SDK's tail-tool-message scan. Later answers
  // replay on the next step.
  const approvalBatch = input.batches.find((batch) => answered.has(batch));
  const openBatches = input.batches.filter((batch) => batch !== approvalBatch);
  const leftoverResponses = responsesForBatches(input.responses, openBatches);

  if (approvalBatch === undefined) {
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

  const approval = resolveApprovalBatch({
    batch: approvalBatch,
    messages: [...input.baseHistory],
    resolveApprovalKey: input.resolveApprovalKey,
    responses: input.responses,
    session: input.session,
  });
  const resolved = buildResolvedInputBatch(approvalBatch, input.responses);

  return finishResolvedInput({
    deferTurnInput: true,
    leftoverResponses,
    messages: approval.messages,
    rejectedActions: approval.rejectedActions,
    resolvedInputs: resolved === undefined ? [] : [resolved],
    resolvedStepInput: input.resolvedStepInput,
    session: removePendingInputBatches(approval.session, [approvalBatch]),
  });
}

/**
 * Resolves the first open approval batch when the person steered the held turn
 * with a message instead of finishing it. Requests they already answered, as in
 * a partial approval, keep that answer; the rest report `ignored`. Later
 * batches stay open, as with answered batches.
 */
export function ignoreApprovalInputBatch(
  input: InputDomainResolverInput & {
    readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  },
): ResolvePendingInputResult {
  const batch = input.batches[0]!;
  const answers = responsesForBatches(input.responses, [batch]);
  const approval = resolveApprovalBatch({
    batch,
    messages: [...input.baseHistory],
    resolveApprovalKey: input.resolveApprovalKey,
    responses: answers,
    session: input.session,
  });
  const resolved = buildResolvedInputBatch(batch, answers);
  return finishResolvedInput({
    // Calls that will not run already have their results, so the message joins
    // this step. An approved call runs through AI SDK, which needs its approval
    // response last, so the message replays after it.
    deferTurnInput: answers.some((answer) => resolveApprovalOutcome(answer).approved),
    leftoverResponses: responsesForBatches(input.responses, input.batches.slice(1)),
    messages: approval.messages,
    rejectedActions: approval.rejectedActions,
    resolvedInputs: resolved === undefined ? [] : [resolved],
    resolvedStepInput: input.resolvedStepInput,
    session: removePendingInputBatches(approval.session, [batch]),
  });
}

const CANCELLED_APPROVAL_REASON = "Cancelled before anyone answered.";

/**
 * Withdraws every pending tool approval when its turn is cancelled. Each held
 * call goes into history with a not-run result, so no call is left without one.
 */
export function cancelApprovalInputBatches(session: HarnessSession): HarnessSession {
  const batches = pendingApprovalBatches(session.state);
  if (batches.length === 0) return session;
  const messages: ModelMessage[] = [...session.history];
  for (const batch of batches) {
    appendResolvedBatchTranscript(
      messages,
      batch,
      buildApprovalBatchToolResponseParts(batch, [], CANCELLED_APPROVAL_REASON),
    );
  }
  return {
    ...removePendingInputBatches(session, batches),
    history: validateHarnessModelMessages(messages),
  };
}

/** Tool approvals still waiting for an answer, which cancelling their turn withdraws. */
export function getPendingApprovalRequests(
  state: HarnessSession["state"],
): readonly InputRequest[] {
  return pendingApprovalBatches(state).flatMap((batch) => batch.requests);
}

function pendingApprovalBatches(state: HarnessSession["state"]): readonly PendingInputBatch[] {
  return getPendingInputBatches(state).filter((batch) => batch.requests.every(isApprovalRequest));
}

/** Returns recorded approval keys that have no matching request still pending. */
export function getApprovedTools(
  session: HarnessSession,
  resolveApprovalKey?: (request: InputRequest) => string | undefined,
): ReadonlySet<string> {
  const approvedTools = readRecordedApprovedTools(session);
  for (const batch of getPendingInputBatches(session.state)) {
    for (const request of batch.requests) {
      if (!isApprovalRequest(request)) continue;
      approvedTools.delete(resolveApprovalKey?.(request) ?? request.action.toolName);
    }
  }
  return approvedTools;
}

function readRecordedApprovedTools(session: HarnessSession): Set<string> {
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
  state[APPROVED_TOOLS_KEY] = [
    ...new Set([...readRecordedApprovedTools(input.session), ...newKeys]),
  ];
  return { ...input.session, state };
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
  /** Why an unanswered request did not run, when not because the user moved on. */
  unansweredReason?: string,
): ToolResponsePart[] {
  const responseMap = new Map(responses.map((response) => [response.requestId, response]));
  const parts: ToolResponsePart[] = [];
  for (const request of batch.requests) {
    const response = responseMap.get(request.requestId);
    switch (request.kind) {
      case "tool-approval":
        parts.push(
          ...buildApprovalToolResponseParts(
            request as ToolApprovalInputRequest,
            response,
            unansweredReason,
          ),
        );
        break;
      case "question":
      case "session-limit":
        throw new TypeError(
          `Approval pending input batches cannot contain a "${request.kind}" request.`,
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
  unansweredReason: string | undefined,
): ToolResponsePart[] {
  const outcome = resolveApprovalOutcome(response);
  const approved = outcome.approved;
  const reason = response === undefined ? (unansweredReason ?? outcome.reason) : outcome.reason;
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
