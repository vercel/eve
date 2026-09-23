import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

export async function dispatchSessionEventHooksStep(input: {
  readonly event: MessageStreamEvent;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const registry = bundle.hookRegistry;
  if (
    (registry.streamEventsByType.get(input.event.type)?.length ?? 0) === 0 &&
    registry.streamEventsWildcard.length === 0
  ) {
    return { serializedContext: input.serializedContext, sessionState: input.sessionState };
  }
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const session = hydrateDurableSession({
    durable: readDurableSession(input.sessionState),
    turnAgent: effectiveAgent.turnAgent,
    compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
  });
  const scoped = await withContextScope(ctx, session, async (enriched) => {
    await dispatchStreamEventHooks({ ctx, registry, event: input.event });
    return { result: undefined, session: enriched };
  });
  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({
      session: reconcileSessionContinuationToken(ctx, scoped.session),
    }),
  };
}
