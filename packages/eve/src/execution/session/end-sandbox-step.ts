import { SandboxTerminalCleanupKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext } from "#context/serialize.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { SandboxSessionEndReason } from "#sandbox/state.js";

export async function endSessionSandboxStep(input: {
  readonly reason: SandboxSessionEndReason;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const durable = readDurableSession(input.sessionState);
  const effectiveAgent = resolveEffectiveAgentRuntime(ctx.require(BundleKey), ctx);
  const session = hydrateDurableSession({
    compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
    durable,
    turnAgent: effectiveAgent.turnAgent,
  });
  await withContextScope(ctx, session, async (enrichedSession) => {
    await ctx.get(SandboxTerminalCleanupKey)?.(input.reason);
    return { result: undefined, session: enrichedSession };
  });
}
