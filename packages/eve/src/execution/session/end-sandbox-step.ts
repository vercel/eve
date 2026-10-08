import { SandboxTerminalCleanupKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext } from "#context/serialize.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { createLogger, logError } from "#internal/logging.js";
import type { SandboxSessionEndReason } from "#sandbox/state.js";

const log = createLogger("execution.session.finalization");

export async function reportSessionSandboxCleanupFailureStep(input: {
  readonly error: unknown;
  readonly outcome: string;
  readonly sessionId: string;
}): Promise<void> {
  "use step";

  logError(log, "failed to clean up terminal session sandbox", input.error, {
    outcome: input.outcome,
    sessionId: input.sessionId,
  });
}

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
