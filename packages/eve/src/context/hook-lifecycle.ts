import { createLogger, logError } from "#internal/logging.js";
import { getAdapterKind } from "#channel/adapter.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { HookContext } from "#public/definitions/hook.js";
import type { RuntimeHookRegistry } from "#runtime/hooks/registry.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import type { ContextContainer } from "./container.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { ContinuationTokenKey } from "./keys.js";

const log = createLogger("hooks");

/**
 * Fans one runtime stream event out to every matching subscriber.
 * Authored handler failures are logged independently. Caller must hold an
 * active ALS scope so hooks see the same context as the rest of the step.
 */
export async function dispatchStreamEventHooks(input: {
  readonly ctx: ContextContainer;
  readonly registry: RuntimeHookRegistry;
  readonly event: MessageStreamEvent;
  /** Records a `ctx.cancel()` request; absent when the event cannot stop a running turn. */
  readonly cancelTurn?: () => void;
}): Promise<void> {
  const typed = input.registry.streamEventsByType.get(input.event.type) ?? [];
  const wildcard = input.registry.streamEventsWildcard;

  if (typed.length === 0 && wildcard.length === 0) {
    return;
  }

  const baseCtx = buildHookContext(input.ctx);
  for (const entry of [...typed, ...wildcard]) {
    const hookCtx: HookContext = {
      ...baseCtx,
      cancel: () => {
        if (input.cancelTurn !== undefined) {
          input.cancelTurn();
          return;
        }
        log.warn("ctx.cancel() ignored: the event is not part of a running turn", {
          hook: entry.slug,
          eventId: input.event.meta.id,
          eventType: input.event.type,
          sessionId: baseCtx.session.id,
        });
      },
    };
    try {
      await entry.handler(input.event, hookCtx);
    } catch (error) {
      logError(log, "stream event hook failed", error, {
        hook: entry.slug,
        subscription: entry.eventType,
        eventId: input.event.meta.id,
        eventType: input.event.type,
        sessionId: baseCtx.session.id,
      });
    }
  }
}

/** Builds the {@link HookContext} fields shared by every handler of one event. */
function buildHookContext(ctx: ContextContainer): Omit<HookContext, "cancel"> {
  const bundle = ctx.require(BundleKey);
  const channelAdapter = ctx.get(ChannelKey);
  const continuationToken = ctx.get(ContinuationTokenKey);
  const kind = channelAdapter !== undefined ? getAdapterKind(channelAdapter) : undefined;
  const callbackCtx = buildCallbackContext();

  return {
    ...callbackCtx,
    agent: {
      name: bundle.turnAgent.id,
      nodeId: bundle.nodeId,
    },
    channel: {
      kind,
      continuationToken,
    },
  };
}
