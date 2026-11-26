import { deliveryIdempotencyKey } from "#runtime/subscriptions/keys.js";
import { SUBSCRIPTION_CHANNEL_KIND } from "#channel/delivery-metadata.js";
import { createAttachSessionFn } from "#channel/session.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import {
  requireCompiledBundle,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { retireSubscriptionOwner } from "#runtime/subscriptions/owner.js";
import type {
  ChannelSubscriptionSource,
  SubscriptionBinding,
} from "#runtime/subscriptions/state.js";
import type { SubscriptionSourceRuntime } from "#runtime/subscriptions/sources/types.js";
import type { ChannelEvent, ChannelSubscription } from "#shared/channel-subscriptions.js";
import { parseJsonObject } from "#shared/json.js";

function channelOf(binding: SubscriptionBinding): ChannelSubscriptionSource {
  if (binding.source.kind !== "channel")
    throw new Error(`Expected a channel subscription, got "${binding.source.kind}".`);
  return binding.source;
}

function onEventOf(bundle: CompiledBundle, source: ChannelSubscriptionSource) {
  return bundle.resolvedAgent.channels.find((channel) => channel.name === source.name)?.definition
    ?.onEvent;
}

function subscriptionOf(binding: SubscriptionBinding): ChannelSubscription {
  const source = channelOf(binding);
  return {
    id: binding.id,
    channelName: source.name,
    event: source.event,
    input: source.input,
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

  async close() {
    return "done";
  },

  async deliver({ ctx, binding, event }) {
    const source = channelOf(binding);
    const bundle = requireCompiledBundle(ctx);
    const onEvent = onEventOf(bundle, source);
    if (onEvent === undefined) return;
    const channelEvent: ChannelEvent = {
      id: event.id,
      name: source.event,
      data: parseJsonObject(event.data),
    };
    const decision = await onEvent({
      auth: binding.auth,
      sessionId: binding.sessionId,
      event: channelEvent,
      subscription: subscriptionOf(binding),
    });
    if (decision === null) return;
    if (typeof decision !== "string" || decision === "")
      throw new Error(
        `The "${source.name}" channel's onEvent must return a message or null, not ${decision === "" ? "an empty string" : typeof decision}.`,
      );
    const attach = createAttachSessionFn(
      createWorkflowRuntime({ compiledArtifactsSource: bundle.compiledArtifactsSource }),
      {
        turnPolicy: "queue",
        channelKind: SUBSCRIPTION_CHANNEL_KIND,
        channelName: source.name,
        requestId: event.id,
      },
    );
    try {
      await attach(binding.sessionId).send(decision, {
        auth: binding.auth,
        turnPolicy: "queue",
        idempotencyKey: deliveryIdempotencyKey(binding.id, event.id),
      });
    } catch (error) {
      if (!SessionNotActiveError.is(error) || error.retryable) throw error;
      await retireSubscriptionOwner(binding.id);
    }
  },
};
