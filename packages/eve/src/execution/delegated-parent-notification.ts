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

/**
 * Resumes the parent driver's hook with a delegated subagent result.
 * No-op for root sessions.
 */
export async function notifyDelegatedParentStep(input: {
  readonly result: RuntimeSubagentResultActionResult | undefined;
  readonly serializedContext: Record<string, unknown>;
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

  process.env.WORKFLOW_QUEUE_NAMESPACE = "eve";
  const { resumeHook } = await import("#compiled/@workflow/core/runtime.js");
  await resumeHook(parentContinuationToken, {
    kind: "runtime-action-result",
    results: [input.result],
  });
}
