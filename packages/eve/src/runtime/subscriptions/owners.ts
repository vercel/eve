import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { EventBinding } from "#runtime/subscriptions/state.js";
import type { ManagedEventSubscription } from "#shared/connection-events.js";

export interface ConnectionEventOwners {
  find(
    bindingId: string,
  ): Promise<
    { owner: EventBinding; subscription: ManagedEventSubscription | undefined } | undefined
  >;
  start(
    binding: EventBinding,
    bundle: CompiledBundle,
    signal?: AbortSignal,
  ): Promise<ManagedEventSubscription | undefined>;
  retire(bindingId: string): Promise<boolean>;
}
