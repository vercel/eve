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
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { getTurnUsageState } from "#harness/turn-tag-state.js";
import { createLogger } from "#internal/logging.js";
import { resumeHook } from "#internal/workflow/runtime.js";

const log = createLogger("execution.delegated-parent-notification");

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

  try {
    const durable = await readDurableSession(sessionState);
    const turn = getTurnUsageState(durable.state);
    if (turn === undefined) {
      return result;
    }
    return {
      ...result,
      usage: {
        cacheReadTokens: turn.session.cacheReadTokens,
        inputTokens: turn.session.inputTokens,
        outputTokens: turn.session.outputTokens,
      },
    };
  } catch (error) {
    log.warn("failed to read delegated subagent usage", { error });
    return result;
  }
}
