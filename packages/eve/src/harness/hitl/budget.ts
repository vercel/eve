/**
 * Session token and token-cost limit policy for the tool-loop harness.
 *
 * Before each model call, {@link checkSessionUsageLimit} says whether the
 * session may call the model. Over budget, a session that can request input
 * asks whether to continue (the machine's `requestLimit`); one nobody can
 * answer fails with `SESSION_TOKEN_LIMIT_REACHED`. The answer is the
 * machine's `answer`: a grant bumps the runtime limits with
 * {@link bumpSessionRuntimeUsageLimits}; a decline cancels the turn tree.
 */
import {
  createSessionLimitContinuationRequest,
  type LimitAsk,
} from "#harness/hitl/budget-request.js";
import {
  getSessionUsageLimitViolation,
  type SessionUsageLimitViolation,
} from "#harness/session-usage.js";
import type { HarnessSession } from "#harness/types.js";
import type { JsonObject } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";

export { bumpSessionRuntimeUsageLimits } from "#harness/session-usage.js";

const SESSION_TOKEN_LIMIT_REACHED_CODE = "SESSION_TOKEN_LIMIT_REACHED";
const SESSION_TOKEN_COST_LIMIT_REACHED_CODE = "SESSION_TOKEN_COST_LIMIT_REACHED";

export type SessionUsageLimitCheck =
  | { readonly kind: "within" }
  | { readonly kind: "ask"; readonly ask: LimitAsk }
  | {
      readonly kind: "fail";
      readonly code: string;
      readonly details: JsonObject;
      readonly message: string;
    };

/** Whether the session may call the model, may ask to continue, or must fail. */
export function checkSessionUsageLimit(input: {
  readonly canAsk: boolean;
  readonly session: HarnessSession;
  readonly turnSequence: number;
  /** What the session has spent: its step's view, which holds what the step published. */
  readonly usage: TokenUsage;
}): SessionUsageLimitCheck {
  const { usage } = input;
  const violation = getSessionUsageLimitViolation(input.session, usage);
  if (violation === null) return { kind: "within" };
  // A zero limit is an exhausted quota inherited by a delegated task.
  // Approving would bump the runtime limit by the configured limit -- zero --
  // so fail the child and let its parent reach the resumable limit gate.
  if (violationWindow(violation) > 0 && input.canAsk) {
    return {
      kind: "ask",
      ask: createSessionLimitContinuationRequest({
        sessionId: input.session.sessionId,
        turnSequence: input.turnSequence,
        violation,
      }),
    };
  }
  return {
    code:
      violation.kind === "token-cost"
        ? SESSION_TOKEN_COST_LIMIT_REACHED_CODE
        : SESSION_TOKEN_LIMIT_REACHED_CODE,
    details:
      violation.kind === "token-cost"
        ? {
            costUsd: usage.costUsd ?? 0,
            kind: violation.kind,
            limitUsd: violation.limitUsd,
            usedCostUsd: violation.usedCostUsd,
          }
        : {
            inputTokens: usage.inputTokens,
            kind: violation.kind,
            limit: violation.limit,
            outputTokens: usage.outputTokens,
            usedTokens: violation.usedTokens,
          },
    kind: "fail",
    message: formatSessionLimitMessage(violation.kind),
  };
}

function violationWindow(violation: SessionUsageLimitViolation): number {
  return violation.kind === "token-cost" ? violation.limitUsd : violation.limit;
}

function formatSessionLimitMessage(kind: SessionUsageLimitViolation["kind"]): string {
  return kind === "token-cost"
    ? "The session reached its configured model token-cost limit."
    : `The session reached its configured ${kind} token limit.`;
}
