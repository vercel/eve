import { createHash } from "node:crypto";
import { getWritable } from "#compiled/@workflow/core/index.js";
import { createAttachSessionFn } from "#channel/session.js";
import { AuthKey } from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { startWorkflowOnCurrentDeployment } from "#execution/workflow-runtime.js";
import { channelEventDeliveryWorkflowReference } from "#execution/workflow-references.js";
import {
  CHANNEL_EVENT_OUTCOME_NAMESPACE,
  type ChannelEventBinding,
  type ChannelEventOutcome,
} from "#runtime/channels/events/state.js";
import { requireCompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ChannelEventDelivery } from "#shared/channel-subscriptions.js";

export interface ChannelEventDeliveryInput {
  readonly binding: ChannelEventBinding;
  readonly serializedContext: Record<string, unknown>;
  readonly delivery: ChannelEventDelivery;
}

export async function announceChannelEventStep(binding: ChannelEventBinding): Promise<void> {
  "use step";
  await publishOutcome({
    status: {
      id: binding.id,
      event: binding.event,
      arguments: binding.arguments,
      sessionId: binding.sessionId,
      status: "active",
      expiresAt: binding.ttlMs === null ? null : new Date(Date.now() + binding.ttlMs).toISOString(),
    },
  });
}

export async function publishChannelEventOwnerStep(ownerRunId: string): Promise<void> {
  "use step";
  await publishOutcome({ ownerRunId });
}

export async function startChannelEventDeliveryStep(
  input: ChannelEventDeliveryInput,
): Promise<void> {
  "use step";
  await startWorkflowOnCurrentDeployment(channelEventDeliveryWorkflowReference, [input]);
}

export async function dispatchChannelEventStep(input: ChannelEventDeliveryInput): Promise<void> {
  "use step";
  const { binding, delivery } = input;
  const ctx = await deserializeContext(input.serializedContext);
  const bundle = requireCompiledBundle(ctx);
  const stillOffered = bundle.resolvedAgent.channels.some(
    (channel) =>
      channel.name === binding.channelName &&
      channel.definition?.subscriptions?.[binding.event] !== undefined,
  );
  if (!stillOffered) return;
  ctx.setVirtualContext(AuthKey, binding.auth);
  const attach = createAttachSessionFn(
    createWorkflowRuntime({ compiledArtifactsSource: bundle.compiledArtifactsSource }),
    {
      turnPolicy: "queue",
      channelKind: "channel-events",
      channelName: binding.channelName,
      requestId: delivery.id,
    },
  );
  await attach(binding.sessionId).send(delivery.message, {
    auth: binding.auth,
    turnPolicy: "queue",
    idempotencyKey: `eve:channel-event:${createHash("sha256")
      .update(`${binding.id}:${delivery.id}`)
      .digest("hex")}`,
  });
}

async function publishOutcome(outcome: ChannelEventOutcome): Promise<void> {
  const writer = getWritable<ChannelEventOutcome>({
    namespace: CHANNEL_EVENT_OUTCOME_NAMESPACE,
  }).getWriter();
  try {
    await writer.write(outcome);
  } finally {
    writer.releaseLock();
  }
}
