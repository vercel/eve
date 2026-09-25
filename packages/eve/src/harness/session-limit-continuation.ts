/**
 * Deterministic HITL continuation prompt for session usage limits.
 *
 * When a durable session reaches its configured token or token-cost budget, the harness
 * parks on a harness-authored input request instead of failing the session.
 * The request is derived only from the session identity and violation, so
 * identical session state always produces an identical prompt — no model call
 * is involved.
 */
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";
import type { SessionUsageLimitViolation } from "#harness/turn-tag-state.js";

/** Synthetic action tool name carried by session-limit continuation requests. */
export const SESSION_LIMIT_CONTINUATION_TOOL_NAME = "session_limit_continuation";

/** Option id that grants a fresh token budget window. */
export const SESSION_LIMIT_CONTINUE_OPTION_ID = "continue";

/** Option id that declines continuation and ends the session. */
export const SESSION_LIMIT_STOP_OPTION_ID = "stop";

/**
 * Builds the deterministic continuation prompt for one session usage-limit
 * violation.
 */
export function createSessionLimitContinuationRequest(input: {
  readonly sessionId: string;
  readonly violation: SessionUsageLimitViolation;
}): InputRequest {
  const { sessionId, violation } = input;
  const used = violation.kind === "token-cost" ? violation.usedCostUsd : violation.usedTokens;
  // The absolute session usage is strictly increasing across violations, so
  // each prompt gets a deterministic id and stale controls cannot resolve a
  // later prompt.
  const requestId = `${sessionId}:limit:${violation.kind}:${String(used)}`;
  const actionInput: JsonObject =
    violation.kind === "token-cost"
      ? {
          kind: violation.kind,
          limitUsd: violation.limitUsd,
          usedCostUsd: violation.usedCostUsd,
        }
      : {
          kind: violation.kind,
          limit: violation.limit,
          usedTokens: violation.usedTokens,
        };

  return {
    action: {
      callId: requestId,
      input: actionInput,
      kind: "tool-call",
      toolName: SESSION_LIMIT_CONTINUATION_TOOL_NAME,
    },
    allowFreeform: false,
    display: "confirmation",
    kind: "session-limit",
    options: [
      {
        description:
          violation.kind === "token-cost"
            ? "Grant a fresh model token-cost budget"
            : "Grant a fresh token budget",
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
    prompt: formatSessionLimitPrompt(violation),
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

function formatSessionLimitPrompt(violation: SessionUsageLimitViolation): string {
  const reachedLimit =
    violation.kind === "token-cost"
      ? `${formatUsd(violation.limitUsd)} model token-cost limit per session`
      : `${violation.kind}-token limit (${formatCompactTokenCount(violation.limit)}) per session`;
  return (
    `This session has hit the ${reachedLimit}. This is a guardrail ` +
    `against defective long-running sessions. If session activity looks fine, ` +
    `just approve to keep going.`
  );
}

function formatUsd(costUsd: number): string {
  const value = costUsd < 0.000001 ? String(costUsd) : costUsd.toFixed(6);
  return `$${value.replace(/0+$/u, "").replace(/\.$/u, "")}`;
}

/**
 * Returns true when a request is a harness-authored session-limit
 * continuation prompt.
 */
export function isSessionLimitContinuationRequest(request: InputRequest): boolean {
  return request.kind === "session-limit";
}

/**
 * Matches request ids minted by {@link createSessionLimitContinuationRequest}.
 *
 * Continuation requests never enter model history (no matching tool call
 * exists), so the id shape is the only durable marker for recognizing a
 * stale continuation answer after its request left the pending batch.
 */
export function isSessionLimitContinuationRequestId(requestId: string): boolean {
  return (
    /:limit:(?:input|output):\d+$/u.test(requestId) ||
    /:limit:token-cost:\d+(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(requestId)
  );
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
