/**
 * Deterministic HITL continuation prompt for session token limits.
 *
 * When a durable session reaches its configured token budget, the harness
 * parks on a harness-authored input request instead of failing the session.
 * The request is derived only from the session identity and violation, so
 * identical session state always produces an identical prompt — no model call
 * is involved.
 */
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { SessionTokenLimitViolation } from "#harness/turn-tag-state.js";

/** Synthetic action tool name carried by session-limit continuation requests. */
export const SESSION_LIMIT_CONTINUATION_TOOL_NAME = "session_limit_continuation";

/** Option id that grants a fresh token budget window. */
export const SESSION_LIMIT_CONTINUE_OPTION_ID = "continue";

/** Option id that declines continuation and ends the session. */
export const SESSION_LIMIT_STOP_OPTION_ID = "stop";

/**
 * Builds the deterministic continuation prompt for one session token limit
 * violation.
 */
export function createSessionLimitContinuationRequest(input: {
  readonly sessionId: string;
  /**
   * Absolute session total of the violated kind (not the window-relative
   * `violation.usedTokens`, which can repeat across grants — e.g. a second
   * violation can land on exactly the same window usage). The absolute total
   * is strictly increasing across violations, so each prompt gets its own id
   * while staying deterministic: stale chat controls from an earlier,
   * already-resolved prompt carry an unknown requestId, resolve nothing, and
   * the harness harmlessly re-prompts instead of letting an old "Stop"
   * button end a freshly granted session.
   */
  readonly totalUsedTokens: number;
  readonly violation: SessionTokenLimitViolation;
}): InputRequest {
  const { sessionId, totalUsedTokens, violation } = input;
  const requestId = `${sessionId}:limit:${violation.kind}:${String(totalUsedTokens)}`;

  return {
    action: {
      callId: requestId,
      input: {
        kind: violation.kind,
        limit: violation.limit,
        usedTokens: violation.usedTokens,
      },
      kind: "tool-call",
      toolName: SESSION_LIMIT_CONTINUATION_TOOL_NAME,
    },
    allowFreeform: false,
    display: "confirmation",
    options: [
      {
        description: "Grant a fresh token budget",
        id: SESSION_LIMIT_CONTINUE_OPTION_ID,
        label: "Approve",
        style: "primary",
      },
      {
        description: "Stop now",
        id: SESSION_LIMIT_STOP_OPTION_ID,
        label: "Stop",
        style: "danger",
      },
    ],
    prompt:
      `This session has hit the ${violation.kind}-token limit ` +
      `(${formatCompactTokenCount(violation.limit)}) per session. This is a guardrail ` +
      `against defective long-running sessions. If session activity looks fine, ` +
      `just approve to keep going.`,
    requestId,
  };
}

/**
 * Formats a token count compactly for prompt copy: `2M`, `1.9M`, `200K`;
 * exact below 1,000.
 */
function formatCompactTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${trimTrailingZero(count / 1_000_000)}M`;
  }
  if (count >= 1_000) {
    return `${trimTrailingZero(count / 1_000)}K`;
  }
  return String(count);
}

function trimTrailingZero(value: number): string {
  const rounded = value.toFixed(1);
  return rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded;
}

/**
 * Returns true when a request is a harness-authored session-limit
 * continuation prompt.
 */
export function isSessionLimitContinuationRequest(request: InputRequest): boolean {
  return request.action.toolName === SESSION_LIMIT_CONTINUATION_TOOL_NAME;
}

/**
 * Matches request ids minted by {@link createSessionLimitContinuationRequest}.
 *
 * Continuation requests never enter model history (no matching tool call
 * exists), so the id shape is the only durable marker for recognizing a
 * stale continuation answer after its request left the pending batch.
 */
export function isSessionLimitContinuationRequestId(requestId: string): boolean {
  return /:limit:(?:input|output):\d+$/u.test(requestId);
}

/**
 * Resolves the user's answer to a session-limit continuation prompt.
 *
 * Returns `{ granted: true }` for "continue", `{ granted: false }` for
 * "stop", and `undefined` when the batch carries no continuation request or
 * the user has not answered it — an unanswered prompt is re-raised on the
 * next step because the violation still holds.
 */
export function resolveSessionLimitContinuation(input: {
  readonly requests: readonly InputRequest[];
  readonly responses: readonly InputResponse[];
}): { readonly granted: boolean } | undefined {
  const request = input.requests.find(isSessionLimitContinuationRequest);
  if (request === undefined) {
    return undefined;
  }

  const response = input.responses.find((entry) => entry.requestId === request.requestId);
  if (response === undefined) {
    return undefined;
  }

  if (response.optionId === SESSION_LIMIT_CONTINUE_OPTION_ID) {
    return { granted: true };
  }
  if (response.optionId === SESSION_LIMIT_STOP_OPTION_ID) {
    return { granted: false };
  }

  return undefined;
}
