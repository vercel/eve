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
  /** What the model passed to `eve__subscribe`. */
  readonly input: JsonObject;
}

/** The session that is subscribed: who it acts as and which session hears the events. */
export interface ChannelSubscriber {
  /** The subscribed session's identity. A subscription never outlives or widens it. */
  readonly auth: SessionAuthContext | null;
  readonly sessionId: string;
}

/**
 * What `onEvent` decides for one subscription and one occurrence. A non-empty string is the
 * message the subscribing session receives. `null` drops the occurrence for that subscription.
 */
export type ChannelEventDecision = string | null;

/** What a session asked to subscribe to, as `onSubscribe` sees it before eve holds it. */
export interface ChannelSubscriptionRequest {
  readonly channelName: string;
  /** The event name the session passed to `eve__subscribe`. */
  readonly event: string;
  /** The scope the session passed, after the channel's input schema accepted it. */
  readonly input: JsonObject;
}

/**
 * Decides whether a session may subscribe, when it calls `eve__subscribe`. Runs as the session,
 * before eve holds the subscription. Throw to deny: the message becomes the tool's error, which
 * the model reads. Return `{ input }` to subscribe to a narrower scope than the one requested, such
 * as one repository the session may read. Return nothing to accept the request as it is. A
 * returned `input` is checked against the channel's input schema again.
 */
export type ChannelOnSubscribe = (
  input: ChannelSubscriber & { readonly subscription: ChannelSubscriptionRequest },
) => ChannelSubscriptionGrant | void | Promise<ChannelSubscriptionGrant | void>;

/** The scope a session is allowed to subscribe to, in place of the one it requested. */
export interface ChannelSubscriptionGrant {
  readonly input: JsonObject;
}

/**
 * A channel's gate and formatter for subscriptions. Defining it lets a session of the agent
 * subscribe to the channel: the model calls `eve__subscribe` with the channel name, an event name
 * and an `input` naming the scope it watches. eve holds the subscription, delivers each occurrence
 * the channel's routes `emit` for the same event name and scope, and ends it when the session
 * stops it or its lifetime runs out.
 *
 * Define `onSubscribe` to decide who may subscribe. Without it any session of the agent can
 * subscribe to any scope the channel emits, and `onEvent` is the only check.
 *
 * Runs once per subscription for each occurrence, as the subscriber. Filter on `event.name`,
 * `event.data` or the subscription here. A message is queued behind a running turn.
 */
export type ChannelOnEvent = (
  input: ChannelSubscriber & {
    readonly event: ChannelEvent;
    readonly subscription: ChannelSubscription;
  },
) => ChannelEventDecision | Promise<ChannelEventDecision>;

/**
 * The experimental `subscriptions` slot of a channel definition: `defineChannel({ experimental: {
 * subscriptions: { onEvent } } })`.
 */
export interface ChannelSubscriptionsDefinition {
  readonly onEvent: ChannelOnEvent;
  readonly onSubscribe?: ChannelOnSubscribe;
  /**
   * The events the channel emits, each with the `input` that scopes it. `eve__search` lists them
   * and `eve__subscribe` rejects any other event name. Without it the model passes any event name
   * and input, as the agent's instructions describe them.
   */
  readonly events?: readonly ChannelEventDefinition[];
}

/** One event a channel emits: its name, what it means, and the JSON Schema of the `input` that scopes it. */
export interface ChannelEventDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
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
