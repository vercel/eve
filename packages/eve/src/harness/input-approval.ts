import type { ModelMessage } from "ai";

import type { PendingInputBatch } from "#harness/input-requests.js";
import { isSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeToolResultActionResult } from "#runtime/actions/types.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";

const APPROVED_TOOLS_KEY = "eve.runtime.hitl.approvedTools";
const IGNORED_INPUT_REASON = "Ignored because the user continued without responding.";
const TOOL_EXECUTION_DENIED_CODE = "TOOL_EXECUTION_DENIED";
const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution was denied.";
const TOOL_EXECUTION_INVALID_APPROVAL_MESSAGE = "Invalid approval response.";

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ApprovalTerminalStatus = "approved" | "denied" | "ignored" | "invalid";

export interface RejectedActionBatch {
  readonly event: NonNullable<PendingInputBatch["event"]>;
  readonly results: readonly RuntimeToolResultActionResult[];
}

export function getApprovedTools(session: HarnessSession): ReadonlySet<string> {
  const value = session.state?.[APPROVED_TOOLS_KEY];
  return Array.isArray(value) ? new Set(value as string[]) : new Set();
}

export function recordApprovedTools(input: {
  readonly pendingBatch: PendingInputBatch;
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly responses: readonly InputResponse[];
  readonly session: HarnessSession;
}): HarnessSession {
  const approvedIds = new Set(
    input.responses
      .filter((response) => response.optionId === "approve")
      .map(({ requestId }) => requestId),
  );
  const newKeys = input.pendingBatch.requests
    .filter(({ requestId }) => approvedIds.has(requestId))
    .map((request) => input.resolveApprovalKey?.(request) ?? request.action.toolName);

  if (newKeys.length === 0) {
    return input.session;
  }

  const approvedTools = [...new Set([...getApprovedTools(input.session), ...newKeys])];
  return {
    ...input.session,
    state: { ...input.session.state, [APPROVED_TOOLS_KEY]: approvedTools },
  };
}

export function buildRejectedActionBatch(
  batch: PendingInputBatch,
  responses: readonly InputResponse[],
): RejectedActionBatch | undefined {
  if (batch.event === undefined) {
    return undefined;
  }

  const responseMap = new Map(responses.map((response) => [response.requestId, response]));
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

export function buildToolResponseParts(
  batch: PendingInputBatch,
  responses: readonly InputResponse[],
): ToolResponsePart[] {
  const responseMap = new Map(responses.map((response) => [response.requestId, response]));
  return batch.requests.flatMap((request) =>
    buildToolResponsePartsForRequest(request, responseMap.get(request.requestId)),
  );
}

function buildToolResponsePartsForRequest(
  request: InputRequest,
  response: InputResponse | undefined,
): ToolResponsePart[] {
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
    if (!approved) {
      parts.push({
        output: { reason, type: "execution-denied" },
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
          response === undefined
            ? { status: "ignored" }
            : { optionId: response.optionId, status: "answered", text: response.text },
      },
      toolCallId: request.action.callId,
      toolName: request.action.toolName,
      type: "tool-result",
    },
  ];
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
  if (response.optionId === "deny") {
    return { approved: false, reason: TOOL_EXECUTION_DENIED_MESSAGE, status: "denied" };
  }
  return {
    approved: false,
    reason: TOOL_EXECUTION_INVALID_APPROVAL_MESSAGE,
    status: "invalid",
  };
}

export function isApprovalRequest(request: InputRequest): boolean {
  return (
    request.options?.length === 2 &&
    request.options[0]?.id === "approve" &&
    request.options[1]?.id === "deny"
  );
}
