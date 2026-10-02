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
import { createSessionLimitContinuationRequest } from "#harness/human-input/budget-request.js";
import {
  getSessionUsageLimitViolation,
  getSessionTokenUsage,
  type SessionUsageLimitViolation,
} from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";

export { bumpSessionRuntimeUsageLimits } from "#harness/turn-tag-state.js";

const SESSION_TOKEN_LIMIT_REACHED_CODE = "SESSION_TOKEN_LIMIT_REACHED";
const SESSION_TOKEN_COST_LIMIT_REACHED_CODE = "SESSION_TOKEN_COST_LIMIT_REACHED";

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
  readonly session: HarnessSession;
}): SessionUsageLimitCheck {
  const violation = getSessionUsageLimitViolation(input.session);
  if (violation === null) return { kind: "within" };
  // A zero limit is an exhausted quota inherited by a delegated task.
  // Approving would bump the runtime limit by the configured limit -- zero --
  // so fail the child and let its parent reach the resumable limit gate.
  if (violationWindow(violation) > 0 && input.canAsk) {
    return {
      kind: "ask",
      request: createSessionLimitContinuationRequest({
        sessionId: input.session.sessionId,
        violation,
      }),
    };
  }
  const usage = getSessionTokenUsage(input.session);
  return {
    code:
      violation.kind === "token-cost"
        ? SESSION_TOKEN_COST_LIMIT_REACHED_CODE
        : SESSION_TOKEN_LIMIT_REACHED_CODE,
    details:
      violation.kind === "token-cost"
        ? {
            costUsd: usage.costUsd,
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
