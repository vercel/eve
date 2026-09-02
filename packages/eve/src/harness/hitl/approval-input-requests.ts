import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import {
  resolveApprovalOutcome,
  TOOL_EXECUTION_DENIED_MESSAGE,
} from "#harness/input-request-resolution.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import type { OpenRequestGroup } from "#harness/hitl/request-ledger.js";
import type {
  ResolvedInputActionBatch,
  RequestVerdict,
  RequestVerdictReducerInput,
  ToolResponsePart,
} from "#harness/hitl/request-verdict.js";
import { appendResolvedBatchTranscript } from "#harness/hitl/pending-input-resolution.js";
import {
  buildQuestionToolResponsePart,
  type QuestionInputRequest,
} from "#harness/hitl/question-input-requests.js";
import type { HarnessSession } from "#harness/types.js";

const APPROVED_TOOLS_KEY = "eve.runtime.hitl.approvedTools";
const TOOL_EXECUTION_DENIED_CODE = "TOOL_EXECUTION_DENIED";
type ToolApprovalInputRequest = InputRequest & { readonly kind: "tool-approval" };

export { type ResolvedInputActionBatch as RejectedActionBatch } from "#harness/hitl/request-verdict.js";

export function hasAnsweredApprovalBatch(
  batches: readonly OpenRequestGroup[],
  responses: readonly InputResponse[],
): boolean {
  const responseIds = new Set(responses.map((response) => response.requestId));
  return batches.some((batch) =>
    batch.requests.every(
      (request) => !isApprovalRequest(request) || responseIds.has(request.requestId),
    ),
  );
}

export function findAnsweredApprovalBatches(
  batches: readonly OpenRequestGroup[],
  responses: readonly InputResponse[],
): OpenRequestGroup[] {
  const responseIds = new Set(responses.map((response) => response.requestId));
  return batches.filter((batch) =>
    batch.requests.every(
      (request) => !isApprovalRequest(request) || responseIds.has(request.requestId),
    ),
  );
}

export function limitApprovalTailBatch(
  resolvedBatches: readonly OpenRequestGroup[],
): OpenRequestGroup[] {
  const firstApprovalIndex = resolvedBatches.findIndex((batch) =>
    batch.requests.some((request) => isApprovalRequest(request)),
  );
  if (firstApprovalIndex < 0) return [...resolvedBatches];
  return resolvedBatches.slice(0, firstApprovalIndex + 1);
}

export function reduceApprovalRequestVerdict(input: RequestVerdictReducerInput): RequestVerdict {
  const session = recordApprovedTools({
    pendingBatch: input.batch,
    resolveApprovalKey: input.resolveApprovalKey,
    responses: input.responses,
    session: input.session,
  });
  const toolParts = buildApprovalBatchToolResponseParts(input.batch, input.responses);
  const messages = [...input.messages];
  appendResolvedBatchTranscript(messages, input.batch, toolParts);
  const rejected = buildRejectedActionBatch(input.batch, input.responses);

  return {
    messages,
    rejectedActions: rejected === undefined ? undefined : [rejected],
    session,
  };
}

/** Returns tool approval keys recorded during this session. */
export function getApprovedTools(session: HarnessSession): ReadonlySet<string> {
  const value = session.state?.[APPROVED_TOOLS_KEY];
  return Array.isArray(value) ? new Set(value as string[]) : new Set();
}

function recordApprovedTools(input: {
  readonly pendingBatch: OpenRequestGroup;
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

function buildRejectedActionBatch(
  batch: OpenRequestGroup,
  responses: readonly InputResponse[],
): ResolvedInputActionBatch | undefined {
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
  batch: OpenRequestGroup,
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
