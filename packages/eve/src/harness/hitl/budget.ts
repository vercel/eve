/**
 * Session usage limit policy for the tool-loop harness.
 *
 * Before each model call, {@link checkSessionUsageLimit} asks the agent's
 * `limits.sessionUsage` whether the session may call the model. Over the
 * limit, a session that can request input asks whether to continue (the
 * machine's `requestLimit`); one nobody can answer fails with
 * `SESSION_USAGE_LIMIT_REACHED`. The answer is the machine's `answer`: a
 * grant starts a new usage window with `resetSessionUsageWindow`; a
 * decline cancels the turn tree.
 */
import {
  createSessionLimitContinuationRequest,
  toJsonUsage,
} from "#harness/hitl/budget-request.js";
import {
  getSessionUsage,
  getSessionUsageWindow,
  getSessionUsageWindowIndex,
} from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";
import type { SessionUsageLimit } from "#shared/agent-definition.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";

const DEFAULT_MAX_NEW_INPUT_TOKENS_PER_WINDOW = 40_000_000;

/**
 * The limit for agents that author none: 40M new input tokens per window. Cache reads are
 * replayed history, not new work, so only uncached input and cache writes count.
 */
export const DEFAULT_SESSION_USAGE_LIMIT: SessionUsageLimit = ({ window }) =>
  window.inputTokens - window.cacheReadTokens >= DEFAULT_MAX_NEW_INPUT_TOKENS_PER_WINDOW;

const SESSION_USAGE_LIMIT_REACHED_CODE = "SESSION_USAGE_LIMIT_REACHED";

export type SessionUsageLimitCheck =
  | { readonly kind: "within" }
  | { readonly kind: "ask"; readonly request: InputRequest }
  | {
      readonly kind: "fail";
      readonly code: string;
      readonly details: JsonObject;
      readonly message: string;
    };

/** Whether the session may call the model, may ask to continue, or must fail. */
export function checkSessionUsageLimit(input: {
  readonly canAsk: boolean;
  readonly limit: SessionUsageLimit;
  readonly session: HarnessSession;
  readonly turnSequence: number;
}): SessionUsageLimitCheck {
  const total = getSessionUsage(input.session);
  const window = getSessionUsageWindow(input.session);
  // An empty window has nothing to judge, and approving could only start another empty one.
  if (isEmptyUsage(window) || !input.limit({ total, window })) return { kind: "within" };
  if (input.canAsk) {
    return {
      kind: "ask",
      request: createSessionLimitContinuationRequest({
        sessionId: input.session.sessionId,
        total,
        turnSequence: input.turnSequence,
        window,
        windowIndex: getSessionUsageWindowIndex(input.session),
      }),
    };
  }
  return {
    code: SESSION_USAGE_LIMIT_REACHED_CODE,
    details: { total: toJsonUsage(total), window: toJsonUsage(window) },
    kind: "fail",
    message: "The session reached its usage limit.",
  };
}

function isEmptyUsage(usage: TokenUsage): boolean {
  return usage.inputTokens === 0 && usage.outputTokens === 0 && !usage.costUsd;
}
