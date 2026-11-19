import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type {
  ChannelSubscriptionBinding,
  ChannelSubscriptionStatus,
} from "#runtime/subscriptions/channel/state.js";
import type { ChannelEvent } from "#shared/channel-subscriptions.js";

export interface ChannelSubscriptionOwners {
  find(bindingId: string): Promise<
    | {
        readonly binding: ChannelSubscriptionBinding;
        readonly status: ChannelSubscriptionStatus | undefined;
      }
    | undefined
  >;
  start(
    binding: ChannelSubscriptionBinding,
    bundle: CompiledBundle,
    signal?: AbortSignal,
  ): Promise<ChannelSubscriptionStatus | undefined>;
  retire(bindingId: string): Promise<boolean>;
  emit(channelName: string, key: string, event: ChannelEvent): Promise<boolean>;
}
