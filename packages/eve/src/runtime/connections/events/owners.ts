import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { EventBinding } from "#runtime/connections/events/state.js";
import type { ManagedEventSubscription } from "#shared/connection-events.js";

// Where a connection's event subscriptions live: each is a durable watch that outlives the turn
// that asked for it. Workflow keeps each as its own run (`owner.ts`); a host without durable
// runs keeps none, and refuses a subscription. The turn step puts its host's owners in the
// turn's context.

/** A host's connection event watches. */
export interface ConnectionEventOwners {
  /** A running watch: who owns it, and its subscription once created. */
  find(
    bindingId: string,
  ): Promise<
    { owner: EventBinding; subscription: ManagedEventSubscription | undefined } | undefined
  >;
  /** Starts a watch; `undefined` while its subscription is still being created. */
  start(
    binding: EventBinding,
    bundle: CompiledBundle,
    signal?: AbortSignal,
  ): Promise<ManagedEventSubscription | undefined>;
  /** Asks a watch to unsubscribe and end; `false` for one that isn't running. */
  retire(bindingId: string): Promise<boolean>;
}
