import { ContextKey } from "#context/key.js";
import type { SessionAuthContext } from "#channel/types.js";
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
  readonly request: ManagedEventSubscribeInput;
  readonly subscription?: ManagedEventSubscription;
  readonly retired?: true;
  readonly gap?: { readonly cursor: string | null; readonly deliveryId: string };
}
export interface ConnectionEventsState {
  readonly bindings: Readonly<Record<string, EventBinding>>;
  readonly receipts: Readonly<Record<string, "pending" | "complete">>;
}
export const ConnectionEventsStateKey = new ContextKey<ConnectionEventsState>(
  "eve.connectionEvents",
);
