import { getAdapterKind } from "#channel/adapter.js";
import { createLogger } from "#internal/logging.js";
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
 * Handler failures are logged and isolated so observe-only hooks cannot
 * interrupt event delivery or agent execution. Caller must hold an active
 * ALS scope so hooks see the same context as the rest of the step.
 */
export async function dispatchStreamEventHooks(input: {
  readonly ctx: ContextContainer;
  readonly registry: RuntimeHookRegistry;
  readonly event: MessageStreamEvent;
}): Promise<void> {
  const typed = input.registry.streamEventsByType.get(input.event.type) ?? [];
  const wildcard = input.registry.streamEventsWildcard;

  if (typed.length === 0 && wildcard.length === 0) {
    return;
  }

  const hookCtx = buildHookContext(input.ctx);
  for (const entry of typed.concat(wildcard)) {
    try {
      await entry.handler(input.event, hookCtx);
    } catch (error) {
      log.error("authored hook event handler failed", {
        error,
        eventType: input.event.type,
        hookSlug: entry.slug,
        subscription: entry.eventType,
      });
    }
  }
}

/** Builds the {@link HookContext} surfaced to one handler. */
function buildHookContext(ctx: ContextContainer): HookContext {
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
