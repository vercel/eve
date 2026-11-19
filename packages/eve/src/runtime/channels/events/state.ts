import type { SessionAuthContext } from "#channel/types.js";
import type { SessionTraceSeed } from "#context/keys.js";
import type { ChannelEventDelivery } from "#shared/channel-subscriptions.js";
import type { JsonObject } from "#shared/json.js";

/** Who subscribed: the session's saved identity, never the identity of whoever triggers an event. */
export type ChannelEventOwner = {
  readonly executionPrincipal: string;
};

/**
 * One subscription. Its `id` identifies the event and its arguments, so a channel holds at most one
 * subscription per occurrence stream and a webhook finds it from the event alone.
 */
export interface ChannelEventBinding extends ChannelEventOwner {
  readonly id: string;
  readonly channelName: string;
  readonly event: string;
  readonly arguments: JsonObject;
  readonly sessionId: string;
  readonly auth: SessionAuthContext | null;
  readonly traceSeed?: SessionTraceSeed;
  readonly ttlMs: number | null;
}

export interface ChannelEventStatus {
  readonly id: string;
  readonly event: string;
  readonly arguments: JsonObject;
  readonly sessionId: string;
  readonly status: "active";
  readonly expiresAt: string | null;
}

export type ChannelEventOutcome =
  | { readonly status: ChannelEventStatus }
  | { readonly ownerRunId: string };

export const CHANNEL_EVENT_OUTCOME_NAMESPACE = "eve.channel-event.outcome";

export type ChannelEventWatchMessage =
  | { readonly kind: "retire" }
  | { readonly kind: "delivery"; readonly delivery: ChannelEventDelivery };

export function channelEventHookToken(id: string): string {
  return `eve:channel-event:${id}`;
}

export function sameChannelEventOwner(left: ChannelEventOwner, right: ChannelEventOwner): boolean {
  return left.executionPrincipal === right.executionPrincipal;
}
