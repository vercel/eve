import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";
import type { ConnectionEventDelivery } from "#shared/connection-events.js";

export interface ConnectionEventPayload {
  readonly kind: "connection-event";
  readonly connectionName: string;
  readonly bindingId: string;
  readonly requestTraceContext?: SpanContext;
  readonly delivery: ConnectionEventDelivery;
}
