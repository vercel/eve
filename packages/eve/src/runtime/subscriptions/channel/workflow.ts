import { createHook, sleep, type HookOptions } from "#compiled/@workflow/core/index.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import {
  announceChannelSubscriptionStep,
  closeChannelSubscriptionStep,
  dispatchChannelSubscriptionStep,
  fanOutChannelEventStep,
  joinChannelKeyStep,
  joinExistingChannelKeyStep,
  leaveChannelKeyStep,
  publishChannelSubscriptionOwnerStep,
  startChannelSubscriptionDeliveryStep,
  type ChannelSubscriptionDeliveryInput,
} from "#runtime/subscriptions/channel/steps.js";
import {
  channelKeyHookToken,
  channelSubscriptionHookToken,
  type ChannelKeyMessage,
  type ChannelSubscriptionBinding,
  type ChannelSubscriptionWatchMessage,
} from "#runtime/subscriptions/channel/state.js";

const REMEMBERED_EVENTS = 256;

/** Holds one session's subscription: joins its key, forwards the events it receives, and leaves when it ends. */
export async function channelSubscriptionWorkflow(input: {
  readonly binding: ChannelSubscriptionBinding;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use workflow";
  const { binding, serializedContext } = input;
  const hook = createHook<ChannelSubscriptionWatchMessage>({
    token: channelSubscriptionHookToken(binding.id),
    // The binding is workflow input, so it is already serialized JSON.
    metadata: binding as unknown as HookOptions["metadata"],
  });
  try {
    await claimHookOwnership(hook);
  } catch (error) {
    if (!isHookConflictError(error) || typeof error.conflictingRunId !== "string") throw error;
    await publishChannelSubscriptionOwnerStep(error.conflictingRunId);
    return;
  }
  await joinChannelKeyStep(binding);
  await announceChannelSubscriptionStep(binding);
  const expiry = binding.ttlMs === null ? undefined : sleep(binding.ttlMs);
  while (true) {
    const message = await (expiry === undefined ? hook : Promise.race([hook, expiry]));
    if (message === undefined || message.kind === "retire") break;
    await startChannelSubscriptionDeliveryStep({
      binding,
      serializedContext,
      event: message.event,
    });
  }
  await leaveChannelKeyStep(binding);
  await closeChannelSubscriptionStep({ binding, serializedContext });
}

/**
 * Fans each event emitted for one channel key out to the subscriptions holding it, once per event
 * id. Ends when the last subscription leaves.
 */
export async function channelSubscriptionKeyWorkflow(input: {
  readonly channelName: string;
  readonly key: string;
  readonly first: string;
}): Promise<void> {
  "use workflow";
  const { channelName, key } = input;
  const hook = createHook<ChannelKeyMessage>({ token: channelKeyHookToken(channelName, key) });
  try {
    await claimHookOwnership(hook);
  } catch (error) {
    if (!isHookConflictError(error)) throw error;
    await joinExistingChannelKeyStep({ channelName, key, bindingId: input.first });
    return;
  }
  const members = new Set([input.first]);
  const seen: string[] = [];
  while (true) {
    const message = await hook;
    if (message.kind === "join") members.add(message.bindingId);
    else if (message.kind === "leave") {
      members.delete(message.bindingId);
      if (members.size === 0) {
        await disposeHook(hook);
        return;
      }
    } else if (!seen.includes(message.event.id)) {
      seen.push(message.event.id);
      if (seen.length > REMEMBERED_EVENTS) seen.shift();
      await fanOutChannelEventStep({ bindingIds: [...members], event: message.event });
    }
  }
}

export async function channelSubscriptionDeliveryWorkflow(
  input: ChannelSubscriptionDeliveryInput,
): Promise<void> {
  "use workflow";
  await dispatchChannelSubscriptionStep(input);
}
