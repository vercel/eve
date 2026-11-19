import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { SessionTraceSeed } from "#context/keys.js";
import type {
  ManagedEventSubscribeInput,
  ManagedEventSubscription,
} from "#shared/connection-events.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

/** A connection's events, held upstream by Connect. */
export interface ConnectionSubscriptionSource {
  readonly kind: "connection";
  readonly name: string;
  readonly instanceId: string | undefined;
  readonly connector: string;
  readonly principalKey: string;
  readonly request: Omit<ManagedEventSubscribeInput, "idempotencyKey" | "options">;
}

/** A channel's subscription to one declared event, addressed by the key `channelEventKey` derives. */
export interface ChannelSubscriptionSource {
  readonly kind: "channel";
  readonly name: string;
  readonly event: string;
  readonly key: string;
  readonly input: JsonObject;
  readonly ttlMs: number | null;
}

export type SubscriptionSource = ConnectionSubscriptionSource | ChannelSubscriptionSource;

/** Names the place events come from. Every key run is held for one of these and one key. */
export interface SubscriptionSourceRef {
  readonly kind: SubscriptionSource["kind"];
  readonly name: string;
}

/** One session's subscription: held by one owner workflow, which joins the key its source opened. */
export interface SubscriptionBinding {
  readonly id: string;
  readonly source: SubscriptionSource;
  readonly sessionId: string;
  /** Who subscribed. Only this identity can read or stop the subscription. */
  readonly executionPrincipal: string;
  readonly auth: SessionAuthContext | null;
  readonly traceSeed?: SessionTraceSeed;
}

export type ConnectionBinding = SubscriptionBinding & {
  readonly source: ConnectionSubscriptionSource;
};

/** What the source reports once a subscription is open. */
export interface OpenedSubscription {
  /** The events {@link SubscriptionKeyMessage} `emit` addresses to this key reach the subscription. */
  readonly key: string;
  readonly expiresAt: string | null;
  /** Connect's record of the subscription; only connection sources have one. */
  readonly upstream?: ManagedEventSubscription;
}

export type OpenOutcome =
  | { readonly opened: OpenedSubscription }
  | { readonly error: string; readonly status?: number };

export type SubscriptionOutcome = OpenOutcome | { readonly ownerRunId: string };

export const SUBSCRIPTION_OUTCOME_NAMESPACE = "eve.subscription.outcome";

/** One occurrence for a key. `id` identifies it, so a redelivery reaches each subscription once. */
export interface SubscriptionEvent {
  readonly id: string;
  readonly data: JsonValue;
  readonly requestTraceContext?: SpanContext;
}

/** What reaches a subscription's owner workflow. */
export type SubscriptionOwnerMessage =
  | { readonly kind: "retire" }
  | { readonly kind: "delivery"; readonly event: SubscriptionEvent };

/** What reaches the workflow that fans one key's events out to the subscriptions holding it. */
export type SubscriptionKeyMessage =
  | { readonly kind: "join"; readonly bindingId: string; readonly ackId: string }
  | { readonly kind: "leave"; readonly bindingId: string }
  | { readonly kind: "emit"; readonly event: SubscriptionEvent };

/**
 * A key run's answer to one join, published under {@link joinAckNamespace}: it holds the
 * subscription, or it passed the join to the run that holds the key.
 */
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
