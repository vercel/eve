/**
 * Deterministic HITL continuation prompt for session usage limits.
 *
 * When a durable session reaches its usage limit, the harness
 * parks on a harness-authored input request instead of failing the session.
 * The request is derived only from the session, turn, and usage, so
 * identical session state always produces an identical prompt — no model call
 * is involved.
 */
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** Synthetic action tool name carried by session-limit continuation requests. */
const SESSION_LIMIT_CONTINUATION_TOOL_NAME = "session_limit_continuation";

/** Option id that starts a new usage window. */
export const SESSION_LIMIT_CONTINUE_OPTION_ID = "continue";

/** Option id that declines continuation and ends the session. */
export const SESSION_LIMIT_STOP_OPTION_ID = "stop";

/**
 * Builds the deterministic continuation prompt for a session that reached its
 * usage limit.
 */
export function createSessionLimitContinuationRequest(input: {
  readonly sessionId: string;
  readonly total: TokenUsage;
  /** The turn's `sequence`, which tells its prompt apart from another turn's at the same usage. */
  readonly turnSequence: number;
  readonly window: TokenUsage;
  /** Which usage window the prompt is for; approving starts the next one. */
  readonly windowIndex: number;
}): InputRequest {
  const { sessionId, total, turnSequence, window, windowIndex } = input;
  // Re-raising an unanswered prompt keeps its id; clients drop ids they've
  // seen, so each window and each turn gets its own. Usage can't tell windows
  // apart: a cost-only window leaves token counts unchanged. The sequence
  // rather than the turn id keeps the id short enough for Discord's
  // 100-character `custom_id`.
  const requestId = `${sessionId}:${String(turnSequence)}:limit:usage:${String(windowIndex)}`;
  const actionInput: JsonObject = { total: toJsonUsage(total), window: toJsonUsage(window) };

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
        description: "Start a new usage window",
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
    prompt: SESSION_LIMIT_PROMPT,
    requestId,
  };
}

/** `usage` as JSON: an unreported cost is left out. */
export function toJsonUsage(usage: TokenUsage): JsonObject {
  const { costUsd, ...tokens } = usage;
  return costUsd === undefined ? tokens : { ...tokens, costUsd };
}

const SESSION_LIMIT_PROMPT =
  "This session has hit its usage limit. This is a guardrail against defective " +
  "long-running sessions. If session activity looks fine, just approve to keep going.";

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
    /:limit:(?:usage|input|output):\d+$/u.test(requestId) ||
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
}): SessionLimitAnswer | undefined {
  const request = input.requests.find(isSessionLimitContinuationRequest);
  if (request === undefined) {
    return undefined;
  }

  const response = input.responses.find((entry) => entry.requestId === request.requestId);
  if (response === undefined) {
    return undefined;
  }
  const granted = sessionLimitDecision(response);
  if (granted === undefined) return undefined;
  const windowIndex = /:limit:usage:(\d+)$/u.exec(request.requestId)?.[1];
  return windowIndex === undefined ? { granted } : { granted, windowIndex: Number(windowIndex) };
}

/** An answer to a session-limit prompt, and the usage window the prompt was for. */
export interface SessionLimitAnswer {
  readonly granted: boolean;
  readonly windowIndex?: number;
}

/**
 * Whether an answer to a session-limit prompt approves (`true`) or stops
 * (`false`). Any other answer, such as an unknown option or text alone,
 * decides nothing.
 */
export function sessionLimitDecision(response: InputResponse): boolean | undefined {
  if (response.optionId === SESSION_LIMIT_CONTINUE_OPTION_ID) return true;
  if (response.optionId === SESSION_LIMIT_STOP_OPTION_ID) return false;
  return undefined;
}
