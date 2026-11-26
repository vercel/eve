import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type {
  OpenedSubscription,
  SubscriptionBinding,
  SubscriptionOccurrence,
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
  emit(
    channelName: string,
    key: string,
    occurrence: SubscriptionOccurrence,
    source: RuntimeCompiledArtifactsSource,
  ): Promise<boolean>;
  deliver(
    bindingId: string,
    from: SubscriptionSourceRef,
    occurrence: SubscriptionOccurrence,
    source: RuntimeCompiledArtifactsSource,
  ): Promise<boolean>;
}
