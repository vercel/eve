/**
 * Session token and token-cost limit policy for the tool-loop harness. Before
 * each model call, an over-budget session either fails the turn or, when a
 * person could grant more budget, hands the question to human input.
 */
import { emitFailedStep, type HarnessEmissionState } from "#harness/emission.js";
import { createSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";
import {
  getSessionUsageLimitViolation,
  getSessionTokenUsage,
  getSessionUsage,
  type SessionUsageLimitViolation,
} from "#harness/turn-tag-state.js";
import type { HarnessSession, StepResult, ToolLoopHarnessConfig } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

const SESSION_TOKEN_LIMIT_REACHED_CODE = "SESSION_TOKEN_LIMIT_REACHED";
const SESSION_TOKEN_COST_LIMIT_REACHED_CODE = "SESSION_TOKEN_COST_LIMIT_REACHED";

export type SessionUsageLimitCheck =
  | { readonly kind: "within" }
  | { readonly kind: "failed"; readonly result: StepResult }
  /** A person can grant a fresh budget window. */
  | { readonly kind: "ask"; readonly request: InputRequest };

/**
 * Pre-model-call gate for the session token budget. Over budget, sessions
 * that can request input ask a person; others fail with
 * `SESSION_TOKEN_LIMIT_REACHED`.
 */
export async function enforceSessionUsageLimit(input: {
  readonly config: ToolLoopHarnessConfig;
  readonly emit?: ToolLoopHarnessConfig["handleEvent"];
  readonly emissionState: HarnessEmissionState;
  readonly session: HarnessSession;
}): Promise<SessionUsageLimitCheck> {
  const violation = getSessionUsageLimitViolation(input.session);
  if (violation === null) return { kind: "within" };

  // A zero limit is an exhausted quota inherited by a delegated task.
  // Approving would bump the runtime limit by the configured limit -- zero --
  // so fail the child and let its parent reach the resumable limit gate.
  if (
    violationWindow(violation) > 0 &&
    input.emit !== undefined &&
    input.config.capabilities?.requestInput === true
  ) {
    return {
      kind: "ask",
      request: createSessionLimitContinuationRequest({
        sessionId: input.session.sessionId,
        violation,
      }),
    };
  }

  return { kind: "failed", result: await failSessionUsageLimit({ ...input, violation }) };
}

function violationWindow(violation: SessionUsageLimitViolation): number {
  return violation.kind === "token-cost" ? violation.limitUsd : violation.limit;
}

function formatSessionLimitMessage(kind: SessionUsageLimitViolation["kind"]): string {
  return kind === "token-cost"
    ? "The session reached its configured model token-cost limit."
    : `The session reached its configured ${kind} token limit.`;
}

async function failSessionUsageLimit(input: {
  readonly config: ToolLoopHarnessConfig;
  readonly emit?: ToolLoopHarnessConfig["handleEvent"];
  readonly emissionState: HarnessEmissionState;
  readonly session: HarnessSession;
  readonly violation: SessionUsageLimitViolation;
}): Promise<StepResult> {
  const usage = getSessionTokenUsage(input.session);
  const message = formatSessionLimitMessage(input.violation.kind);
  const details: import("#shared/json.js").JsonObject =
    input.violation.kind === "token-cost"
      ? {
          costUsd: usage.costUsd,
          kind: input.violation.kind,
          limitUsd: input.violation.limitUsd,
          usedCostUsd: input.violation.usedCostUsd,
        }
      : {
          inputTokens: usage.inputTokens,
          kind: input.violation.kind,
          limit: input.violation.limit,
          outputTokens: usage.outputTokens,
          usedTokens: input.violation.usedTokens,
        };

  if (input.emit) {
    await emitFailedStep(input.emit, input.emissionState, {
      code:
        input.violation.kind === "token-cost"
          ? SESSION_TOKEN_COST_LIMIT_REACHED_CODE
          : SESSION_TOKEN_LIMIT_REACHED_CODE,
      details,
      message,
      sessionId: input.session.sessionId,
      usage: getSessionUsage(input.session),
    });
  }

  return {
    next: { done: true, output: "" },
    session: input.session,
  };
}
