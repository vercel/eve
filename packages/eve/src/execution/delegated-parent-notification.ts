/**
 * Bridges a delegated subagent's terminal outcome back to its parent
 * driver via the subagent-result hook. Pure projection helpers live
 * in `delegated-parent-result.ts` so the workflow step-proxy transform
 * doesn't strip them from this file.
 */

import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";
import { isSubagentAdapterState, SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { createErrorId, createLogger } from "#internal/logging.js";
import { resumeHook } from "#internal/workflow/runtime.js";

const log = createLogger("execution.delegated-parent-notification");

/**
 * Resumes the parent driver's hook with a delegated subagent result.
 * No-op for root sessions.
 *
 * Parent resume after a delegated child completes is **guaranteed** for
 * well-formed subagent adapters: failures to resume are logged and
 * rethrown so the child run fails visibly instead of leaving the parent
 * parked on `${completionToken}:inbox` forever.
 *
 * `usage` — the completed child's session-total token spend — is
 * attached to success results so the caller can attribute the
 * subagent's tokens. Error results never carry usage.
 */
export async function notifyDelegatedParentStep(input: {
  readonly result: RuntimeSubagentResultActionResult | undefined;
  readonly serializedContext: Record<string, unknown>;
  readonly usage?: TokenUsage;
}): Promise<void> {
  "use step";

  if (input.result === undefined) {
    return;
  }

  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.get(ChannelKey);

  if (adapter?.kind !== SUBAGENT_ADAPTER_KIND) {
    return;
  }

  if (!isSubagentAdapterState(adapter.state)) {
    const errorId = createErrorId();
    log.error("delegated child has invalid subagent adapter state; parent will not be notified", {
      callId: input.result.callId,
      errorId,
      subagentName: input.result.subagentName,
    });
    throw new Error(
      `Delegated subagent adapter state is invalid (errorId=${errorId}); ` +
        "parent turn cannot be resumed with the subagent result.",
    );
  }

  const parentContinuationToken = adapter.state.parentContinuationToken;
  const result =
    input.usage === undefined || input.result.isError === true
      ? input.result
      : { ...input.result, usage: input.usage };

  try {
    await resumeHook(parentContinuationToken, {
      kind: "runtime-action-result",
      results: [result],
    });
  } catch (error) {
    const errorId = createErrorId();
    const hookNotFound = error instanceof Error && error.name === "HookNotFoundError";
    log.error("failed to resume parent hook with delegated subagent result", {
      callId: adapter.state.callId,
      errorId,
      hookNotFound,
      parentContinuationToken,
      parentSessionId: adapter.state.parentSessionId,
      subagentName: adapter.state.subagentName,
      error,
    });
    throw error;
  }
}
