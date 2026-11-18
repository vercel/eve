import type { SessionAuthContext } from "#channel/types.js";
import type { SessionTraceSeed } from "#context/keys.js";
import type {
  ManagedEventSubscribeInput,
  ManagedEventSubscription,
} from "#shared/connection-events.js";

export type EventOwner = {
  readonly connectionName: string;
  readonly instanceId: string | undefined;
  readonly connector: string;
  readonly principalKey: string;
  readonly executionPrincipal: string;
};

export interface EventBinding extends EventOwner {
  readonly id: string;
  readonly sessionId: string;
  readonly auth: SessionAuthContext | null;
  readonly traceSeed?: SessionTraceSeed;
  readonly request: Omit<ManagedEventSubscribeInput, "idempotencyKey" | "options">;
}

export const CONNECTION_EVENT_SUBSCRIPTION_NAMESPACE = "eve.connection-event.subscription";

export type ConnectionEventSubscribeResult =
  | { readonly subscription: ManagedEventSubscription }
  | { readonly error: string; readonly status?: number };

export type ConnectionEventSubscribeOutcome =
  | ConnectionEventSubscribeResult
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
