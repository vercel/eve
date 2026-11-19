import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ChannelEventBinding, ChannelEventStatus } from "#runtime/channels/events/state.js";
import type { ChannelEventDelivery } from "#shared/channel-subscriptions.js";

export interface ChannelEventOwners {
  find(
    bindingId: string,
  ): Promise<{ binding: ChannelEventBinding; status: ChannelEventStatus | undefined } | undefined>;
  start(
    binding: ChannelEventBinding,
    bundle: CompiledBundle,
    signal?: AbortSignal,
  ): Promise<ChannelEventStatus | undefined>;
  retire(bindingId: string): Promise<boolean>;
  publish(bindingId: string, delivery: ChannelEventDelivery): Promise<boolean>;
}
