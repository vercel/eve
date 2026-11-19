import type { SessionAuthContext } from "#channel/types.js";
import type { SessionTraceSeed } from "#context/keys.js";
import type { ChannelEvent } from "#shared/channel-subscriptions.js";
import type { JsonObject } from "#shared/json.js";

/** One session's subscription to a channel key, held by one owner workflow until it ends. */
export interface ChannelSubscriptionBinding {
  readonly id: string;
  readonly channelName: string;
  readonly key: string;
  readonly input: JsonObject;
  readonly sessionId: string;
  /** Who subscribed. Only this identity can read, stop or listen to the subscription. */
  readonly executionPrincipal: string;
  readonly auth: SessionAuthContext | null;
  readonly traceSeed?: SessionTraceSeed;
  readonly ttlMs: number | null;
}

export interface ChannelSubscriptionStatus {
  readonly id: string;
  readonly channel: string;
  readonly input: JsonObject;
  readonly status: "active";
  readonly expiresAt: string | null;
}

export type ChannelSubscriptionOutcome =
  | { readonly status: ChannelSubscriptionStatus }
  | { readonly ownerRunId: string };

export const CHANNEL_SUBSCRIPTION_OUTCOME_NAMESPACE = "eve.channel-subscription.outcome";

/** What reaches a subscription's owner workflow. */
export type ChannelSubscriptionWatchMessage =
  | { readonly kind: "retire" }
  | { readonly kind: "delivery"; readonly event: ChannelEvent };

/** What reaches the workflow that fans one key's events out to the subscriptions holding it. */
export type ChannelKeyMessage =
  | { readonly kind: "join"; readonly bindingId: string }
  | { readonly kind: "leave"; readonly bindingId: string }
  | { readonly kind: "emit"; readonly event: ChannelEvent };

export function channelSubscriptionHookToken(id: string): string {
  return `eve:channel-subscription:${id}`;
}

export function channelKeyHookToken(channelName: string, key: string): string {
  return `eve:channel-subscription-key:${encodeURIComponent(channelName)}:${encodeURIComponent(key)}`;
}
