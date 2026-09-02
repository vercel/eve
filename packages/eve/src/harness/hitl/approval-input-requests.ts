import type { ModelMessage } from "ai";

import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { isInputRequest, type InputRequest, type InputResponse } from "#shared/input.js";
import {
  resolveApprovalOutcome,
  TOOL_EXECUTION_DENIED_MESSAGE,
} from "#harness/input-request-resolution.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import type {
  OpenRequestGroup,
  RequestOutcome,
  ResolvedInputActionBatch,
} from "#harness/hitl/request-ledger.js";
import {
  appendResolvedBatchTranscript,
  type ReducerInput,
  type ReducerResult,
} from "#harness/hitl/request-interpreter.js";
import {
  buildQuestionToolResponsePart,
  type QuestionInputRequest,
} from "#harness/hitl/question-input-requests.js";
import type { HarnessSession } from "#harness/types.js";

const APPROVED_TOOLS_KEY = "eve.runtime.hitl.approvedTools";
const TOOL_EXECUTION_DENIED_CODE = "TOOL_EXECUTION_DENIED";
type ToolApprovalInputRequest = InputRequest & { readonly kind: "tool-approval" };

export { type ResolvedInputActionBatch as RejectedActionBatch } from "#harness/hitl/request-ledger.js";

export function hasAnsweredApprovalBatch<T extends { readonly requests: readonly InputRequest[] }>(
  batches: readonly T[],
  responses: readonly InputResponse[],
): boolean {
  const responseIds = new Set(responses.map((response) => response.requestId));
  return batches.some((batch) =>
    batch.requests.every(
      (request) => !isApprovalRequest(request) || responseIds.has(request.requestId),
    ),
  );
}

export function findAnsweredApprovalBatches<
  T extends { readonly requests: readonly InputRequest[] },
>(batches: readonly T[], responses: readonly InputResponse[]): T[] {
  const responseIds = new Set(responses.map((response) => response.requestId));
  return batches.filter((batch) =>
    batch.requests.every(
      (request) => !isApprovalRequest(request) || responseIds.has(request.requestId),
    ),
  );
}

export function limitApprovalTailBatch<T extends { readonly requests: readonly InputRequest[] }>(
  resolvedBatches: readonly T[],
): T[] {
  const firstApprovalIndex = resolvedBatches.findIndex((batch) =>
    batch.requests.some((request) => isApprovalRequest(request)),
  );
  if (firstApprovalIndex < 0) return [...resolvedBatches];
  return resolvedBatches.slice(0, firstApprovalIndex + 1);
}

export function reduceApprovalRequestVerdict(
  input: ReducerInput,
): ReducerResult & { readonly approvedToolKeys: readonly string[] } {
  const toolParts = buildApprovalBatchToolResponseParts(input.group, input.responses);
  const messages = [...input.messages];
  appendResolvedBatchTranscript(messages, input.group, toolParts);
  const rejected = buildRejectedActionBatch(input.group, input.responses);
  const approvedToolKeys = buildApprovedToolKeys(input);

  return {
    approvedToolKeys,
    messages,
    outcomes: new Map(
      input.records
        .map((record) => [record.id, record.outcome] as const)
        .filter((entry): entry is readonly [string, RequestOutcome] => entry[1] !== undefined),
    ),
    rejectedActions: rejected === undefined ? undefined : [rejected],
  };
}

/** Returns tool approval keys recorded during this session. */
export function getApprovedTools(session: HarnessSession): ReadonlySet<string> {
  const value = session.state?.[APPROVED_TOOLS_KEY];
  return Array.isArray(value) ? new Set(value as string[]) : new Set();
}

export function recordApprovedToolKeys(
  session: HarnessSession,
  keys: readonly string[],
): HarnessSession {
  if (keys.length === 0) return session;
  const state = { ...session.state };
  state[APPROVED_TOOLS_KEY] = [...new Set([...getApprovedTools(session), ...keys])];
  return { ...session, state };
}

function buildApprovedToolKeys(input: ReducerInput): readonly string[] {
  return input.records.flatMap((record) => {
    if (
      !isInputRequest(record.request) ||
      !isApprovalRequest(record.request) ||
      record.outcome?.kind !== "approved"
    ) {
      return [];
    }
    return [input.resolveApprovalKey?.(record.request) ?? record.request.action.toolName];
  });
}

function buildRejectedActionBatch(
  group: OpenRequestGroup,
  responses: readonly InputResponse[],
): ResolvedInputActionBatch | undefined {
  if (group.event === undefined) return undefined;

  const responseMap = new Map(responses.map((response) => [response.requestId, response]));
  const results: RuntimeToolResultActionResult[] = [];
  for (const request of group.requests) {
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

  return results.length > 0 ? { event: group.event, results } : undefined;
}

function buildApprovalBatchToolResponseParts(
  group: OpenRequestGroup,
  responses: readonly InputResponse[],
): Extract<ModelMessage, { role: "tool" }>["content"] {
  const responseMap = new Map(responses.map((response) => [response.requestId, response]));
  const parts: Extract<ModelMessage, { role: "tool" }>["content"] = [];
  for (const request of group.requests) {
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
): Extract<ModelMessage, { role: "tool" }>["content"] {
  const { approved, reason } = resolveApprovalOutcome(response);
  const parts: Extract<ModelMessage, { role: "tool" }>["content"] = [
    { approvalId: request.requestId, approved, reason, type: "tool-approval-response" },
  ];
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
