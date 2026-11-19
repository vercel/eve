import type { SessionAuthContext } from "#channel/types.js";
import type { JsonObject } from "#shared/json.js";

/** One occurrence a route hands to {@link EmitChannelEventFn}. */
export interface ChannelEvent {
  /** Identifies the occurrence, so a redelivery of it reaches each subscriber once. */
  readonly id: string;
  /** What the occurrence carries. `onEvent` turns it into the message the subscriber receives. */
  readonly data: JsonObject;
}

/** What one session asked for, as `onSubscribe`, `onUnsubscribe` and `onEvent` see it. */
export interface ChannelSubscription {
  readonly id: string;
  readonly channelName: string;
  /** What the model passed to `subscribe`, already validated against `inputSchema`. */
  readonly input: JsonObject;
  /** The key `onSubscribe` returned: the events `emit` addresses to it reach this subscription. */
  readonly key: string;
  readonly sessionId: string;
}

/** The session that is subscribing: who it acts as and which session hears the events. */
export interface ChannelSubscriber {
  /** The subscribing session's identity. A subscription never outlives or widens it. */
  readonly auth: SessionAuthContext | null;
  readonly sessionId: string;
}

/**
 * How a channel lets a session ask to hear about something later. The model calls the `subscribe`
 * tool with `input`; eve then holds the subscription, delivers each occurrence the channel's routes
 * `emit` for its key, and ends it when the session stops it or its lifetime runs out.
 */
export interface ChannelSubscriptions {
  /** What the subscription reports, written for the model that decides whether to subscribe. */
  readonly description: string;
  /** JSON Schema of the input the model passes: which occurrences it wants to hear about. */
  readonly inputSchema: JsonObject;
  /**
   * Runs when the model subscribes, as the subscribing session. Authorizes the request, opens
   * anything the channel needs upstream, and returns the key that `emit` addresses events to.
   * Throwing refuses the subscription and the model sees the message.
   */
  readonly onSubscribe: (
    input: ChannelSubscriber & { readonly input: JsonObject },
  ) => Promise<{ readonly key: string }> | { readonly key: string };
  /** Runs once when a subscription ends, to close anything `onSubscribe` opened upstream. */
  readonly onUnsubscribe?: (
    input: ChannelSubscriber & { readonly subscription: ChannelSubscription },
  ) => void | Promise<void>;
  /**
   * Runs once per subscription for each occurrence, as the subscriber. Returns the message the
   * subscribing session receives, queued behind a running turn, or nothing to drop the occurrence.
   * Without it the session receives the event's data as JSON.
   */
  readonly onEvent?: (
    input: ChannelSubscriber & {
      readonly event: ChannelEvent;
      readonly subscription: ChannelSubscription;
    },
  ) => string | undefined | Promise<string | undefined>;
}

/**
 * Hands one occurrence to every subscription holding `key`. Resolves `true` when at least one
 * subscription holds the key and `false` when nobody is subscribed.
 */
export type EmitChannelEventFn = (key: string, event: ChannelEvent) => Promise<boolean>;
