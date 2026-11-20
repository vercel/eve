import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { SessionTraceSeed } from "#context/keys.js";
import type {
  ManagedEventSubscribeInput,
  ManagedEventSubscription,
} from "#shared/connection-events.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

export interface ConnectionSubscriptionSource {
  readonly kind: "connection";
  readonly name: string;
  readonly instanceId: string | undefined;
  readonly connector: string;
  readonly principalKey: string;
  readonly request: Omit<ManagedEventSubscribeInput, "idempotencyKey" | "options">;
}

export interface ChannelSubscriptionSource {
  readonly kind: "channel";
  readonly name: string;
  readonly event: string;
  readonly key: string;
  readonly input: JsonObject;
  readonly ttlMs: number | null;
}

export type SubscriptionSource = ConnectionSubscriptionSource | ChannelSubscriptionSource;

export interface SubscriptionSourceRef {
  readonly kind: SubscriptionSource["kind"];
  readonly name: string;
}

export interface SubscriptionBinding {
  readonly id: string;
  readonly source: SubscriptionSource;
  readonly sessionId: string;
  readonly executionPrincipal: string;
  readonly auth: SessionAuthContext | null;
  readonly traceSeed?: SessionTraceSeed;
}

export type ConnectionBinding = SubscriptionBinding & {
  readonly source: ConnectionSubscriptionSource;
};

export interface OpenedSubscription {
  readonly key: string;
  readonly expiresAt: string | null;
  readonly upstream?: ManagedEventSubscription;
}

export type OpenOutcome =
  | { readonly opened: OpenedSubscription }
  | { readonly error: string; readonly status?: number };

export type SubscriptionOutcome = OpenOutcome | { readonly ownerRunId: string };

export const SUBSCRIPTION_OUTCOME_NAMESPACE = "eve.subscription.outcome";

export interface SubscriptionEvent {
  readonly id: string;
  readonly data: JsonValue;
  readonly requestTraceContext?: SpanContext;
  readonly acceptedDeploymentId?: string;
}

export type SubscriptionOwnerMessage =
  | { readonly kind: "retire" }
  | { readonly kind: "delivery"; readonly event: SubscriptionEvent };

export type SubscriptionKeyMessage =
  | { readonly kind: "join"; readonly bindingId: string; readonly ackId: string }
  | { readonly kind: "leave"; readonly bindingId: string }
  | { readonly kind: "emit"; readonly event: SubscriptionEvent };

export type JoinAck = { readonly joined: true } | { readonly forwardedTo: string };

export function joinAckNamespace(ackId: string): string {
  return `eve.subscription.join.${ackId}`;
}

export function subscriptionHookToken(bindingId: string): string {
  return `eve:subscription:${bindingId}`;
}

export function subscriptionKeyHookToken(source: SubscriptionSourceRef, key: string): string {
  return `eve:subscription-key:${source.kind}:${encodeURIComponent(source.name)}:${encodeURIComponent(key)}`;
}

export function sourceRef(source: SubscriptionSource): SubscriptionSourceRef {
  return { kind: source.kind, name: source.name };
}
