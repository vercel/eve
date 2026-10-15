import type { SessionAuthContext } from "#channel/types.js";
import type { SessionTraceSeed } from "#context/keys.js";
import type {
  ManagedEventSubscribeInput,
  ManagedEventSubscription,
} from "#shared/connection-events.js";

export interface EventBinding {
  readonly id: string;
  readonly sessionId: string;
  readonly connectionName: string;
  readonly instanceId: string | undefined;
  readonly connector: string;
  readonly principalKey: string;
  readonly executionPrincipal: string;
  readonly auth: SessionAuthContext | null;
  readonly traceSeed?: SessionTraceSeed;
  readonly request: ManagedEventSubscribeInput;
  readonly subscription?: ManagedEventSubscription;
  readonly retired?: true;
  /** The termination delivery may finish after its retirement write is retried. */
  readonly terminationDeliveryId?: string;
  readonly gap?: { readonly cursor: string | null; readonly deliveryId: string };
}
export interface ConnectionEventHandlerState {
  readonly binding: EventBinding;
  readonly receipts: Readonly<Record<string, "pending" | "complete">>;
}
