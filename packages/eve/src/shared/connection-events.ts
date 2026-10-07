import type { ConnectionPrincipal } from "#shared/connection-types.js";
import type { Experimental_ConnectionEvent } from "#public/definitions/connections/events.js";

// The bridge is structural so auth helpers do not need a runtime dependency on eve.
export type EventJson = string | number | boolean | null | EventJson[] | EventJsonObject;
export type EventJsonObject = { [key: string]: EventJson | undefined };
export interface ManagedEventSubscription {
  id: string;
  name: string;
  arguments: EventJsonObject;
  status: "pending" | "active" | "needs_auth" | "stopped" | "expired" | "failed";
  expiresAt: string | null;
  cleanupStatus?: "pending" | "complete" | "exhausted";
}
export type ManagedEventSubscribeInput = {
  name: string;
  arguments: EventJsonObject;
  context?: EventJsonObject;
  idempotencyKey: string;
  options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number };
} & ({ ttlMs: number; expiresAt?: never } | { expiresAt: string | null; ttlMs?: never });
export interface ConnectionEventsAdapter {
  subscribe(input: ManagedEventSubscribeInput): Promise<ManagedEventSubscription>;
  getSubscription(input: {
    id: string;
    options?: { timeout?: number };
  }): Promise<ManagedEventSubscription>;
  listSubscriptions(input?: {
    cursor?: string;
    limit?: number;
    status?: ManagedEventSubscription["status"];
  }): Promise<{ subscriptions: ManagedEventSubscription[]; nextCursor?: string }>;
  unsubscribe(input: {
    id: string;
    options?: { timeout?: number };
  }): Promise<ManagedEventSubscription>;
}
export type ConnectionEventDelivery = {
  version: 1;
  deliveryId: string;
  subscriptionId: string;
  source: { type: "mcp"; connectorId: string };
  context: Record<string, unknown>;
} & (
  | { event: Experimental_ConnectionEvent }
  | { control: { type: "gap"; cursor: string | null; truncated?: true } }
  | { control: { type: "terminated"; error: { code: number; message: string; data?: unknown } } }
);
export interface ConnectionEventsBackend {
  createAdapter(input: {
    principal: ConnectionPrincipal;
    connection: { url: string };
    destination: { path: string };
  }): Promise<ConnectionEventsAdapter>;
  verify(request: Request, options: { path: string }): Promise<ConnectionEventDelivery>;
}

export function readConnectionEventsBackend(value: unknown): ConnectionEventsBackend | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    !("createAdapter" in value) ||
    typeof value.createAdapter !== "function" ||
    !("verify" in value) ||
    typeof value.verify !== "function"
  ) {
    throw new TypeError(
      "Connect experimental_events must provide createAdapter and verify methods.",
    );
  }
  return value as ConnectionEventsBackend;
}
