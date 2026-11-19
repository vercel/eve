import type { SessionAuthContext } from "#channel/types.js";
import type { JsonObject } from "#shared/json.js";

/** One occurrence a route hands to {@link EmitChannelEventFn}. */
export interface ChannelOccurrence {
  /** Identifies the occurrence, so a redelivery of it reaches each subscriber once. */
  readonly id: string;
  /** What the occurrence carries. `onEvent` turns it into the message the subscriber receives. */
  readonly data: JsonObject;
}

/** One occurrence as `onEvent` sees it, with the name the subscriber watched it under. */
export interface ChannelEvent extends ChannelOccurrence {
  readonly name: string;
}

/** What one session asked for, as `onEvent` sees it. */
export interface ChannelSubscription {
  readonly id: string;
  readonly channelName: string;
  /** The event name the session subscribed to, such as `check_suite.completed`. */
  readonly event: string;
  /** What the model passed to `subscribe`, already validated against `inputSchema`. */
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
 * What `onEvent` decides for one subscription and one occurrence. A string is the message the
 * subscribing session receives. `true` sends the occurrence's data as the message. `false` or
 * nothing drops the occurrence for that subscription.
 */
export type ChannelEventDecision = string | boolean | undefined;

/**
 * What a channel lets a session subscribe to. Any event name can be subscribed to; the channel's
 * `onEvent` decides, for each subscription and each occurrence, whether and how it is delivered.
 * The model calls the `subscribe` tool with an event name and an `input` naming the scope it
 * watches; eve holds the subscription, delivers each occurrence the channel's routes `emit` for
 * the same event name and scope, and ends it when the session stops it or its lifetime runs out.
 */
export interface ChannelSubscriptions {
  /** What the channel reports and how its event names are written, for the model deciding to subscribe. */
  readonly description: string;
  /**
   * JSON Schema of the scope the model passes with an event name. A route's `emit` reaches the
   * subscriptions whose scope equals the scope it passes, compared exactly. Constrain a
   * case-insensitive value, such as with a lowercase `pattern`, and pass it in that case from `emit`.
   */
  readonly inputSchema: JsonObject;
  /**
   * Runs once per subscription for each occurrence, as the subscriber. Filter on `event.name`,
   * `event.data` or the subscription here. A message is queued behind a running turn.
   */
  readonly onEvent: (
    input: ChannelSubscriber & {
      readonly event: ChannelEvent;
      readonly subscription: ChannelSubscription;
    },
  ) => ChannelEventDecision | Promise<ChannelEventDecision>;
}

/**
 * Hands one occurrence of the event `event` to every subscription whose scope equals `input`.
 * Resolves `true` when at least one subscription holds it and `false` when nobody is subscribed.
 */
export type EmitChannelEventFn = (
  event: string,
  input: JsonObject,
  occurrence: ChannelOccurrence,
) => Promise<boolean>;
