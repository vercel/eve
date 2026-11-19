import type { SessionAuthContext } from "#channel/types.js";
import type { JsonObject } from "#shared/json.js";

/** One occurrence a route hands to {@link EmitChannelEventFn}. */
export interface ChannelEvent {
  /** Identifies the occurrence, so a redelivery of it reaches each subscriber once. */
  readonly id: string;
  /** What the occurrence carries. `onEvent` turns it into the message the subscriber receives. */
  readonly data: JsonObject;
}

/** What one session asked for, as `onEvent` sees it. */
export interface ChannelSubscription {
  readonly id: string;
  readonly channelName: string;
  /** The name the channel declared the event under, such as `checks_finished`. */
  readonly event: string;
  /** What the model passed to `subscribe`, already validated against the event's `inputSchema`. */
  readonly input: JsonObject;
  readonly sessionId: string;
}

/** The session that is subscribed: who it acts as and which session hears the events. */
export interface ChannelSubscriber {
  /** The subscribed session's identity. A subscription never outlives or widens it. */
  readonly auth: SessionAuthContext | null;
  readonly sessionId: string;
}

/**
 * One event a channel lets a session subscribe to. The channel's author decides which events are
 * eligible by declaring them. The model calls the `subscribe` tool with the event's name and
 * `input`; eve holds the subscription, delivers each occurrence the channel's routes `emit` for
 * the same event and input, and ends it when the session stops it or its lifetime runs out.
 */
export interface ChannelEventSubscription {
  /** What the event reports, written for the model that decides whether to subscribe. */
  readonly description: string;
  /**
   * JSON Schema of the input the model passes. The input is what identifies the thing watched:
   * a route's `emit` reaches the subscriptions whose input equals the input it passes, compared
   * exactly. Constrain a case-insensitive value, such as with a lowercase `pattern`, and pass it
   * in that case from `emit`.
   */
  readonly inputSchema: JsonObject;
  /**
   * Runs once per subscription for each occurrence, as the subscriber. Returns the message the
   * subscribing session receives, queued behind a running turn, or nothing to drop the occurrence.
   * Without it the session receives the occurrence's data as JSON.
   */
  readonly onEvent?: (
    input: ChannelSubscriber & {
      readonly event: ChannelEvent;
      readonly subscription: ChannelSubscription;
    },
  ) => string | undefined | Promise<string | undefined>;
}

/** The events a channel makes eligible for subscription, by event name. */
export type ChannelSubscriptions = Readonly<Record<string, ChannelEventSubscription>>;

/**
 * Hands one occurrence of `event` to every subscription whose input equals `input`. Resolves
 * `true` when at least one subscription holds it and `false` when nobody is subscribed.
 */
export type EmitChannelEventFn = (
  event: string,
  input: JsonObject,
  occurrence: ChannelEvent,
) => Promise<boolean>;
