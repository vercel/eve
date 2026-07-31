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
import { SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter-state.js";

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

  // The child's own session id: the parent verifies it against the identity
  // captured at dispatch before the result may settle the pending call. An
  // empty claim would be silently dropped by that filter and hang the parent
  // forever, so a missing key must fail loud here instead.
  const sessionId = serializedContext["eve.sessionId"];
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(
      "Serialized context is missing eve.sessionId; the delegated parent result cannot claim its session.",
    );
  }

  return {
    callId: String(channel.state?.callId ?? ""),
    kind: "subagent-result",
    output: output as JsonValue,
    sessionId,
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

  return {
    ...success,
    isError: true,
    output: {
      code: SUBAGENT_EXECUTION_FAILED,
      message: toErrorMessage(error),
    },
  };
}
