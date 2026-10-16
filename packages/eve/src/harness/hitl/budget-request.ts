import { APPROVE_OPTION_ID, DENY_OPTION_ID } from "#shared/input.js";
/**
 * Deterministic HITL continuation prompt for session usage limits.
 *
 * When a durable session reaches its configured token or token-cost budget, the harness
 * parks on a harness-authored input request instead of failing the session.
 * The request is derived only from the session, turn, and violation, so
 * identical session state always produces an identical prompt — no model call
 * is involved.
 */
import type { InteractionRequest } from "#protocol/session-events/families/interaction.js";
import type { ResponseValue } from "#protocol/session-events/families/response.js";
import type { SessionUsageLimitViolation } from "#harness/session-usage.js";

/** The budget prompt: whether to continue past the session's limit. */
export interface LimitAsk {
  readonly interactionId: string;
  readonly request: InteractionRequest;
}

/**
 * Builds the deterministic continuation prompt for one session usage-limit
 * violation.
 */
export function createSessionLimitContinuationRequest(input: {
  readonly sessionId: string;
  /** The turn's `sequence`, which tells its prompt apart from another turn's at the same usage. */
  readonly turnSequence: number;
  readonly violation: SessionUsageLimitViolation;
}): LimitAsk {
  const { sessionId, turnSequence, violation } = input;
  const used = violation.kind === "token-cost" ? violation.usedCostUsd : violation.usedTokens;
  // Re-raising an unanswered prompt within a turn keeps its id. Usage alone
  // doesn't separate prompts across turns: after Stop the next turn is over
  // budget at the same usage, and clients drop request ids they've seen. The
  // sequence rather than the turn id keeps the id short enough for Discord's
  // 100-character `custom_id`.
  const interactionId = `${sessionId}:${String(turnSequence)}:limit:${violation.kind}:${String(used)}`;
  return {
    interactionId,
    request: {
      allowFreeform: false,
      display: "confirmation",
      kind: "budget",
      options: [
        {
          description:
            violation.kind === "token-cost"
              ? "Grant a fresh model token-cost budget"
              : "Grant a fresh token budget",
          id: APPROVE_OPTION_ID,
          label: "Approve",
          style: "primary",
        },
        {
          description: "Stop now",
          id: DENY_OPTION_ID,
          label: "Stop",
          style: "danger",
        },
      ],
      prompt: formatSessionLimitPrompt(violation),
    },
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
 * What an answer to the budget prompt decides: "approve" grants a fresh budget, "deny" declines
 * it, and anything else decides nothing, so the prompt asks again while the violation holds.
 */
export function limitDecision(answer: ResponseValue): { readonly granted: boolean } | undefined {
  if (answer.optionId === APPROVE_OPTION_ID) return { granted: true };
  if (answer.optionId === DENY_OPTION_ID) return { granted: false };
  return undefined;
}
