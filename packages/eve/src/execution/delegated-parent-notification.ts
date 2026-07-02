/**
 * Bridges a delegated subagent's terminal outcome back to its parent
 * driver via the subagent-result hook. Pure projection helpers live
 * in `delegated-parent-result.ts` so the workflow step-proxy transform
 * doesn't strip them from this file.
 */

import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";
import { SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter.js";
import { readCompletedSessionUsage } from "#execution/completed-session-usage.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/**
 * Resumes the parent driver's hook with a delegated subagent result.
 * No-op for root sessions.
 *
 * When `sessionState` is provided and the result is a success, the
 * completed child's session-total token usage is attached so the caller
 * can attribute the subagent's tokens. Usage collection is best-effort:
 * a failed read never blocks the parent notification.
 */
export async function notifyDelegatedParentStep(input: {
  readonly result: RuntimeSubagentResultActionResult | undefined;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState?: DurableSessionState;
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

  const parentContinuationToken = String(adapter.state?.parentContinuationToken ?? "");
  if (parentContinuationToken === "") {
    return;
  }

  await resumeHook(parentContinuationToken, {
    kind: "runtime-action-result",
    results: [await withCompletedSessionUsage(input.result, input.sessionState)],
  });
}

async function withCompletedSessionUsage(
  result: RuntimeSubagentResultActionResult,
  sessionState: DurableSessionState | undefined,
): Promise<RuntimeSubagentResultActionResult> {
  if (sessionState === undefined || result.isError === true) {
    return result;
  }

  const usage = await readCompletedSessionUsage(sessionState);
  return usage === undefined ? result : { ...result, usage };
}
