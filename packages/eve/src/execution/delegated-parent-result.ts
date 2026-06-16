/**
 * Pure helpers that project a delegated subagent's terminal output
 * into the runtime-action result shape its parent driver expects.
 * Lives in its own (non-directive) file to escape the workflow
 * step-proxy transform.
 */

import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";
import type { JsonValue } from "#shared/json.js";
import { toErrorMessage } from "#shared/errors.js";
import { SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter.js";

/**
 * Builds the success-shaped {@link RuntimeSubagentResultActionResult}.
 * Returns `undefined` for root sessions (no parent to notify).
 */
export function createDelegatedSubagentSuccessResult(
  serializedContext: Record<string, unknown>,
  output: unknown,
): RuntimeSubagentResultActionResult | undefined {
  const channel = serializedContext["eve.channel"] as
    | { kind?: string; state?: Record<string, unknown> }
    | undefined;

  if (channel?.kind !== SUBAGENT_ADAPTER_KIND) {
    return undefined;
  }

  return {
    callId: String(channel.state?.callId ?? ""),
    kind: "subagent-result",
    output: output as JsonValue,
    subagentName: String(channel.state?.subagentName ?? ""),
  };
}

/** Failure-path mirror of {@link createDelegatedSubagentSuccessResult}. */
export function createDelegatedSubagentErrorResult(
  serializedContext: Record<string, unknown>,
  error: unknown,
): RuntimeSubagentResultActionResult | undefined {
  const success = createDelegatedSubagentSuccessResult(serializedContext, "");

  if (success === undefined) {
    return undefined;
  }

  return {
    ...success,
    isError: true,
    output: {
      code: "SUBAGENT_EXECUTION_FAILED",
      message: toErrorMessage(error),
    },
  };
}
