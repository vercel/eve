import type { SessionAuthContext } from "#channel/types.js";
import type { SessionTraceSeed } from "#context/keys.js";
import type {
  ManagedEventSubscribeInput,
  ManagedEventSubscription,
} from "#shared/connection-events.js";

/** Who owns a watch. The handler's hook carries it so management can authorize callers. */
export type EventOwner = {
  readonly connectionName: string;
  readonly instanceId: string | undefined;
  readonly connector: string;
  readonly principalKey: string;
  readonly executionPrincipal: string;
};

/** The handler run's input: everything a delivery needs, saved before subscribing. */
export interface EventBinding extends EventOwner {
  readonly id: string;
  readonly sessionId: string;
  readonly auth: SessionAuthContext | null;
  readonly traceSeed?: SessionTraceSeed;
  /** The watch's own run adds the idempotency key, so each run subscribes once. */
  readonly request: Omit<ManagedEventSubscribeInput, "idempotencyKey" | "options">;
}

/** The run publishes its subscription once, so callers outside it can read what it owns. */
export const CONNECTION_EVENT_SUBSCRIPTION_NAMESPACE = "eve.connection-event.subscription";

/** What a run's own subscribe produced. */
export type ConnectionEventSubscribeResult =
  | { readonly subscription: ManagedEventSubscription }
  /** Connect refused the subscription; `status` keeps its HTTP status, such as a 401 that asks for sign-in. */
  | { readonly error: string; readonly status?: number };

export type ConnectionEventSubscribeOutcome =
  | ConnectionEventSubscribeResult
  /** Another run already owns this binding: read the outcome from that run. */
  | { readonly ownerRunId: string };

export function sameEventOwner(left: EventOwner, right: EventOwner): boolean {
  return (
    left.connectionName === right.connectionName &&
    left.instanceId === right.instanceId &&
    left.connector === right.connector &&
    left.principalKey === right.principalKey &&
    left.executionPrincipal === right.executionPrincipal
  );
}
