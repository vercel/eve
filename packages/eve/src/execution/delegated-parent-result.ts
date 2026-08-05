/**
 * Pure helpers that project a delegated subagent's terminal output
 * into the runtime-action result shape its parent driver expects.
 * Lives in its own (non-directive) file to escape the workflow
 * step-proxy transform.
 */

import { SUBAGENT_EXECUTION_FAILED } from "#harness/agent-handle-errors.js";
import type { RuntimeSubagentChildResult } from "#runtime/actions/types.js";
import type { JsonValue } from "#shared/json.js";
import { toErrorMessage } from "#shared/errors.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter-state.js";

const ZERO_TOKEN_USAGE: TokenUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/**
 * Builds the success-shaped {@link RuntimeSubagentChildResult}.
 * Returns `undefined` for root sessions (no parent to notify).
 */
export function createDelegatedSubagentSuccessResult(
  serializedContext: Record<string, unknown>,
  output: unknown,
): RuntimeSubagentChildResult | undefined {
  const channel = serializedContext["eve.channel"] as
    | { kind?: string; state?: Record<string, unknown> }
    | undefined;

  if (channel?.kind !== SUBAGENT_ADAPTER_KIND) {
    return undefined;
  }

  // A task child ends with its result, so the outcome is always terminal.
  // `usageDelta` starts at zero; the notification step folds in the child's
  // session totals when it has them (task children report exactly once).
  return {
    callId: String(channel.state?.callId ?? ""),
    kind: "subagent-result",
    origin: "child",
    outcome: {
      kind: "terminal",
      result: { kind: "succeeded", output: output as JsonValue },
      usageDelta: ZERO_TOKEN_USAGE,
    },
    output: output as JsonValue,
    subagentName: String(channel.state?.subagentName ?? ""),
  };
}

/** Failure-path mirror of {@link createDelegatedSubagentSuccessResult}. */
export function createDelegatedSubagentErrorResult(
  serializedContext: Record<string, unknown>,
  error: unknown,
): RuntimeSubagentChildResult | undefined {
  const success = createDelegatedSubagentSuccessResult(serializedContext, "");

  if (success === undefined) {
    return undefined;
  }

  const output = {
    code: SUBAGENT_EXECUTION_FAILED,
    message: toErrorMessage(error),
  };
  return {
    ...success,
    isError: true,
    outcome: {
      kind: "terminal",
      result: { error: output, kind: "failed" },
      usageDelta: ZERO_TOKEN_USAGE,
    },
    output,
  };
}
