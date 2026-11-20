import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type {
  OpenedSubscription,
  SubscriptionBinding,
  SubscriptionEvent,
  SubscriptionSourceRef,
} from "#runtime/subscriptions/state.js";

export interface SubscriptionOwners {
  find(
    bindingId: string,
  ): Promise<{ binding: SubscriptionBinding; opened: OpenedSubscription | undefined } | undefined>;
  start(
    binding: SubscriptionBinding,
    bundle: CompiledBundle,
    signal?: AbortSignal,
  ): Promise<OpenedSubscription | undefined>;
  retire(bindingId: string): Promise<boolean>;
  emit(source: SubscriptionSourceRef, key: string, event: SubscriptionEvent): Promise<boolean>;
}
