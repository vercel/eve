import { createHook, sleep, type HookOptions } from "#compiled/@workflow/core/index.js";
import { claimHookOwnership, isHookConflictError } from "#execution/hook-ownership.js";
import {
  announceChannelEventStep,
  dispatchChannelEventStep,
  publishChannelEventOwnerStep,
  startChannelEventDeliveryStep,
  type ChannelEventDeliveryInput,
} from "#runtime/channels/events/steps.js";
import {
  channelEventHookToken,
  type ChannelEventBinding,
  type ChannelEventWatchMessage,
} from "#runtime/channels/events/state.js";

const REMEMBERED_DELIVERIES = 256;

export async function channelEventWorkflow(input: {
  readonly binding: ChannelEventBinding;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use workflow";
  const { binding, serializedContext } = input;
  const hook = createHook<ChannelEventWatchMessage>({
    token: channelEventHookToken(binding.id),
    // The binding is workflow input, so it is already serialized JSON.
    metadata: binding as unknown as HookOptions["metadata"],
  });
  try {
    await claimHookOwnership(hook);
  } catch (error) {
    if (!isHookConflictError(error) || typeof error.conflictingRunId !== "string") throw error;
    await publishChannelEventOwnerStep(error.conflictingRunId);
    return;
  }
  await announceChannelEventStep(binding);
  const expiry = binding.ttlMs === null ? undefined : sleep(binding.ttlMs);
  const delivered: string[] = [];
  while (true) {
    const message = await (expiry === undefined ? hook : Promise.race([hook, expiry]));
    if (message === undefined || message.kind === "retire") return;
    if (delivered.includes(message.delivery.id)) continue;
    delivered.push(message.delivery.id);
    if (delivered.length > REMEMBERED_DELIVERIES) delivered.shift();
    await startChannelEventDeliveryStep({ binding, serializedContext, delivery: message.delivery });
  }
}

export async function channelEventDeliveryWorkflow(
  input: ChannelEventDeliveryInput,
): Promise<void> {
  "use workflow";
  await dispatchChannelEventStep(input);
}
