import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession } from "#execution/session.js";
import {
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { RuntimeHookRegistry } from "#runtime/hooks/registry.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

/** Where a step publishes session events, and the session state it leaves behind. */
export interface SessionEventTarget {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionWritable: WritableStream<Uint8Array>;
}

export interface PublishedSessionEvents {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Publishes events a step emits outside a turn, such as task and agent events,
 * then runs their hooks in the session's context. Hooks may use the session's
 * sandbox, so the context and session they leave behind are kept. Call from a
 * step; a throwing hook fails it, like any hook outside a turn.
 */
export async function publishSessionEvents(
  target: SessionEventTarget,
  events: readonly UnstampedMessageStreamEvent[],
): Promise<PublishedSessionEvents> {
  const unchanged = {
    serializedContext: target.serializedContext,
    sessionState: target.sessionState,
  };
  if (events.length === 0) return unchanged;
  const published: MessageStreamEvent[] = [];
  for (const event of events) {
    published.push(await writeSessionEvent(target.sessionWritable, event));
  }

  const ctx = await deserializeContext(target.serializedContext);
  const bundle = ctx.require(BundleKey);
  if (!published.some((event) => hasSubscribers(bundle.hookRegistry, event))) return unchanged;

  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const session = hydrateDurableSession({
    compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
    durable: readDurableSession(target.sessionState),
    turnAgent: effectiveAgent.turnAgent,
  });
  const scoped = await withContextScope(ctx, session, async (enrichedSession) => {
    for (const event of published) {
      await dispatchStreamEventHooks({ ctx, event, registry: bundle.hookRegistry });
    }
    return { result: undefined, session: enrichedSession };
  });
  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({
      session: reconcileSessionContinuationToken(ctx, scoped.session),
    }),
  };
}

/** Writes one event straight to the session stream, without hooks; call from a step. */
export async function writeSessionEvent(
  sessionWritable: WritableStream<Uint8Array>,
  event: UnstampedMessageStreamEvent,
): Promise<MessageStreamEvent> {
  const stamped = stampMessageStreamEvent(event);
  const writer = sessionWritable.getWriter();
  try {
    await writer.write(encodeMessageStreamEvent(stamped));
  } finally {
    writer.releaseLock();
  }
  return stamped;
}

function hasSubscribers(registry: RuntimeHookRegistry, event: MessageStreamEvent): boolean {
  return (
    registry.streamEventsWildcard.length > 0 ||
    (registry.streamEventsByType.get(event.type)?.length ?? 0) > 0
  );
}
