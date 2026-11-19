import { createHash } from "node:crypto";
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

function declarationOf(bundle: CompiledBundle, source: ChannelSubscriptionSource) {
  return bundle.resolvedAgent.channels.find((channel) => channel.name === source.name)?.definition
    ?.subscriptions;
}

function subscriptionOf(binding: SubscriptionBinding): ChannelSubscription {
  const source = channelOf(binding);
  return {
    id: binding.id,
    channelName: source.name,
    event: source.event,
    input: source.input,
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

  async close() {
    return "done";
  },

  async deliver({ ctx, binding, event }) {
    const source = channelOf(binding);
    const bundle = requireCompiledBundle(ctx);
    const declaration = declarationOf(bundle, source);
    if (declaration === undefined) return;
    const channelEvent: ChannelEvent = {
      id: event.id,
      name: source.event,
      data: parseJsonObject(event.data),
    };
    const decision = await declaration.onEvent({
      auth: binding.auth,
      sessionId: binding.sessionId,
      event: channelEvent,
      subscription: subscriptionOf(binding),
    });
    if (decision === undefined || decision === false) return;
    const message = decision === true ? JSON.stringify(channelEvent.data) : decision;
    const attach = createAttachSessionFn(
      createWorkflowRuntime({ compiledArtifactsSource: bundle.compiledArtifactsSource }),
      {
        turnPolicy: "queue",
        channelKind: "channel-subscriptions",
        channelName: source.name,
        requestId: event.id,
      },
    );
    try {
      await attach(binding.sessionId).send(message, {
        auth: binding.auth,
        turnPolicy: "queue",
        idempotencyKey: `eve:subscription:${createHash("sha256")
          .update(`${binding.id}:${event.id}`)
          .digest("hex")}`,
      });
    } catch (error) {
      if (!SessionNotActiveError.is(error) || error.retryable) throw error;
      await retireSubscriptionOwner(binding.id);
    }
  },
};
