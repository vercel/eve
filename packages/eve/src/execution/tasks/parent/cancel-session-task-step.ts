import { deserializeContext } from "#context/serialize.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import { cancelOwnedTask } from "#execution/tasks/parent/dispatch.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { findSessionTaskEntry } from "#tasks/session-index.js";

export type CancelSessionTaskResult = "cancelled" | "not-found" | "settled";

/** Cancels one task only when the current durable session owns it. */
export async function cancelSessionTaskStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly taskId: string;
}): Promise<CancelSessionTaskResult> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const entry = findSessionTaskEntry(durableSession.state, input.taskId);
  if (entry === undefined) return "not-found";

  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const session = hydrateDurableSession({
    compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
    durable: durableSession,
    turnAgent: effectiveAgent.turnAgent,
  });
  const view = await cancelOwnedTask({
    bundle,
    entry,
    serializedContext: input.serializedContext,
    session,
  });
  return view.status === "cancelled" ? "cancelled" : "settled";
}
