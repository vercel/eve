import { createHash } from "node:crypto";
import { createAttachSessionFn } from "#channel/session.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import {
  requireCompiledBundle,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import type {
  ChannelSubscriptionSource,
  SubscriptionBinding,
} from "#runtime/subscriptions/state.js";
import type { SubscriptionSourceRuntime } from "#runtime/subscriptions/sources/types.js";
import type { ChannelEvent, ChannelSubscription } from "#shared/channel-subscriptions.js";

function channelOf(binding: SubscriptionBinding): ChannelSubscriptionSource {
  if (binding.source.kind !== "channel")
    throw new Error(`Expected a channel subscription, got "${binding.source.kind}".`);
  return binding.source;
}

function subscriptionsOf(bundle: CompiledBundle, channelName: string) {
  return bundle.resolvedAgent.channels.find((channel) => channel.name === channelName)?.definition
    ?.subscriptions;
}

function subscriptionOf(binding: SubscriptionBinding): ChannelSubscription {
  const source = channelOf(binding);
  return {
    id: binding.id,
    channelName: source.name,
    input: source.input,
    key: source.key,
    sessionId: binding.sessionId,
  };
}

export const channelSource: SubscriptionSourceRuntime = {
  async open({ binding }) {
    const { key, ttlMs } = channelOf(binding);
    return {
      opened: {
        key,
        expiresAt: ttlMs === null ? null : new Date(Date.now() + ttlMs).toISOString(),
      },
    };
  },

  async close({ ctx, binding }) {
    const subscriptions = subscriptionsOf(requireCompiledBundle(ctx), channelOf(binding).name);
    await subscriptions?.onUnsubscribe?.({
      auth: binding.auth,
      sessionId: binding.sessionId,
      subscription: subscriptionOf(binding),
    });
    return "done";
  },

  async deliver({ ctx, binding, event }) {
    const source = channelOf(binding);
    const bundle = requireCompiledBundle(ctx);
    const subscriptions = subscriptionsOf(bundle, source.name);
    if (subscriptions === undefined) return;
    const channelEvent = event as ChannelEvent;
    const message =
      subscriptions.onEvent === undefined
        ? JSON.stringify(channelEvent.data)
        : await subscriptions.onEvent({
            auth: binding.auth,
            sessionId: binding.sessionId,
            event: channelEvent,
            subscription: subscriptionOf(binding),
          });
    if (message === undefined) return;
    const attach = createAttachSessionFn(
      createWorkflowRuntime({ compiledArtifactsSource: bundle.compiledArtifactsSource }),
      {
        turnPolicy: "queue",
        channelKind: "channel-subscriptions",
        channelName: source.name,
        requestId: event.id,
      },
    );
    await attach(binding.sessionId).send(message, {
      auth: binding.auth,
      turnPolicy: "queue",
      idempotencyKey: `eve:subscription:${createHash("sha256")
        .update(`${binding.id}:${event.id}`)
        .digest("hex")}`,
    });
  },
};
