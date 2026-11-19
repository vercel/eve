import { createHash } from "node:crypto";
import { getWritable } from "#compiled/@workflow/core/index.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { createAttachSessionFn } from "#channel/session.js";
import { AuthKey } from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import {
  channelSubscriptionDeliveryWorkflowReference,
  channelSubscriptionKeyWorkflowReference,
} from "#execution/workflow-references.js";
import {
  createWorkflowRuntime,
  startWorkflowOnCurrentDeployment,
} from "#execution/workflow-runtime.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { requireCompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import {
  CHANNEL_SUBSCRIPTION_OUTCOME_NAMESPACE,
  channelKeyHookToken,
  channelSubscriptionHookToken,
  type ChannelKeyMessage,
  type ChannelSubscriptionBinding,
  type ChannelSubscriptionOutcome,
  type ChannelSubscriptionWatchMessage,
} from "#runtime/subscriptions/channel/state.js";
import type { ChannelEvent, ChannelSubscription } from "#shared/channel-subscriptions.js";

export interface ChannelSubscriptionDeliveryInput {
  readonly binding: ChannelSubscriptionBinding;
  readonly serializedContext: Record<string, unknown>;
  readonly event: ChannelEvent;
}

export async function announceChannelSubscriptionStep(
  binding: ChannelSubscriptionBinding,
): Promise<void> {
  "use step";
  await publishOutcome({
    status: {
      id: binding.id,
      channel: binding.channelName,
      input: binding.input,
      status: "active",
      expiresAt: binding.ttlMs === null ? null : new Date(Date.now() + binding.ttlMs).toISOString(),
    },
  });
}

export async function publishChannelSubscriptionOwnerStep(ownerRunId: string): Promise<void> {
  "use step";
  await publishOutcome({ ownerRunId });
}

/** Adds the subscription to its key's fan-out workflow, starting that workflow when none is running. */
export async function joinChannelKeyStep(binding: ChannelSubscriptionBinding): Promise<void> {
  "use step";
  if (await resumeKey(binding, { kind: "join", bindingId: binding.id })) return;
  await startWorkflowOnCurrentDeployment(channelSubscriptionKeyWorkflowReference, [
    { channelName: binding.channelName, key: binding.key, first: binding.id },
  ]);
}

export async function leaveChannelKeyStep(binding: ChannelSubscriptionBinding): Promise<void> {
  "use step";
  await resumeKey(binding, { kind: "leave", bindingId: binding.id });
}

export async function joinExistingChannelKeyStep(input: {
  readonly channelName: string;
  readonly key: string;
  readonly bindingId: string;
}): Promise<void> {
  "use step";
  await resumeHook(channelKeyHookToken(input.channelName, input.key), {
    kind: "join",
    bindingId: input.bindingId,
  } satisfies ChannelKeyMessage);
}

/** Hands one event to each subscription's owner workflow, skipping subscriptions that ended. */
export async function fanOutChannelEventStep(input: {
  readonly bindingIds: readonly string[];
  readonly event: ChannelEvent;
}): Promise<void> {
  "use step";
  await Promise.all(
    input.bindingIds.map(async (bindingId) => {
      try {
        await resumeHook(channelSubscriptionHookToken(bindingId), {
          kind: "delivery",
          event: input.event,
        } satisfies ChannelSubscriptionWatchMessage);
      } catch (error) {
        if (!HookNotFoundError.is(error)) throw error;
      }
    }),
  );
}

export async function startChannelSubscriptionDeliveryStep(
  input: ChannelSubscriptionDeliveryInput,
): Promise<void> {
  "use step";
  await startWorkflowOnCurrentDeployment(channelSubscriptionDeliveryWorkflowReference, [input]);
}

export async function dispatchChannelSubscriptionStep(
  input: ChannelSubscriptionDeliveryInput,
): Promise<void> {
  "use step";
  const { binding, event } = input;
  const ctx = await deserializeContext(input.serializedContext);
  const bundle = requireCompiledBundle(ctx);
  const subscriptions = subscriptionsOf(bundle, binding.channelName);
  if (subscriptions === undefined) return;
  ctx.setVirtualContext(AuthKey, binding.auth);
  const message =
    subscriptions.onEvent === undefined
      ? JSON.stringify(event.data)
      : await subscriptions.onEvent({
          auth: binding.auth,
          sessionId: binding.sessionId,
          event,
          subscription: subscriptionOf(binding),
        });
  if (message === undefined) return;
  const attach = createAttachSessionFn(
    createWorkflowRuntime({ compiledArtifactsSource: bundle.compiledArtifactsSource }),
    {
      turnPolicy: "queue",
      channelKind: "channel-subscriptions",
      channelName: binding.channelName,
      requestId: event.id,
    },
  );
  await attach(binding.sessionId).send(message, {
    auth: binding.auth,
    turnPolicy: "queue",
    idempotencyKey: `eve:channel-subscription:${createHash("sha256")
      .update(`${binding.id}:${event.id}`)
      .digest("hex")}`,
  });
}

export async function closeChannelSubscriptionStep(input: {
  readonly binding: ChannelSubscriptionBinding;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use step";
  const { binding } = input;
  const ctx = await deserializeContext(input.serializedContext);
  const subscriptions = subscriptionsOf(requireCompiledBundle(ctx), binding.channelName);
  ctx.setVirtualContext(AuthKey, binding.auth);
  await subscriptions?.onUnsubscribe?.({
    auth: binding.auth,
    sessionId: binding.sessionId,
    subscription: subscriptionOf(binding),
  });
}

function subscriptionsOf(bundle: ReturnType<typeof requireCompiledBundle>, channelName: string) {
  return bundle.resolvedAgent.channels.find((channel) => channel.name === channelName)?.definition
    ?.subscriptions;
}

function subscriptionOf(binding: ChannelSubscriptionBinding): ChannelSubscription {
  return {
    id: binding.id,
    channelName: binding.channelName,
    input: binding.input,
    key: binding.key,
    sessionId: binding.sessionId,
  };
}

async function resumeKey(
  binding: Pick<ChannelSubscriptionBinding, "channelName" | "key">,
  message: ChannelKeyMessage,
): Promise<boolean> {
  try {
    await resumeHook(channelKeyHookToken(binding.channelName, binding.key), message);
    return true;
  } catch (error) {
    if (HookNotFoundError.is(error)) return false;
    throw error;
  }
}

async function publishOutcome(outcome: ChannelSubscriptionOutcome): Promise<void> {
  const writer = getWritable<ChannelSubscriptionOutcome>({
    namespace: CHANNEL_SUBSCRIPTION_OUTCOME_NAMESPACE,
  }).getWriter();
  try {
    await writer.write(outcome);
  } finally {
    writer.releaseLock();
  }
}
