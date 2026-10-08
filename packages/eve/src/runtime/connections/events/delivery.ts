import type { ConnectionEventDelivery } from "#shared/connection-events.js";

/** Only the verified receiver constructs this internal session command. */
export interface ConnectionEventInboxPayload {
  readonly kind: "connection-event";
  readonly connectionName: string;
  readonly bindingId: string;
  readonly delivery: ConnectionEventDelivery;
}
