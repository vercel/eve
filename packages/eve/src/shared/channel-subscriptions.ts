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
  /** What the model passed to `subscribe`. */
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
 * subscribing session receives; an empty string drops it. `true` sends the occurrence's data as the
 * message. `false` or nothing drops the occurrence for that subscription.
 */
export type ChannelEventDecision = string | boolean | undefined;

/**
 * A channel's gate and formatter for subscriptions. Defining it lets a session of the agent
 * subscribe to the channel: the model calls `subscribe` with the channel name, an event name and an
 * `input` naming the scope it watches. eve holds the subscription, delivers each occurrence the
 * channel's routes `emit` for the same event name and scope, and ends it when the session stops it
 * or its lifetime runs out.
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

export interface ChannelSubscriptionCatalog {
  readonly description: string;
  readonly events: readonly string[];
  readonly inputSchema: JsonObject;
}

const CATALOG = Symbol.for("eve.channelSubscriptionCatalog");

export function withSubscriptionCatalog(
  onEvent: ChannelOnEvent,
  catalog: ChannelSubscriptionCatalog,
): ChannelOnEvent {
  return Object.assign((input: Parameters<ChannelOnEvent>[0]) => onEvent(input), {
    [CATALOG]: catalog,
  });
}

export function subscriptionCatalogOf(
  onEvent: ChannelOnEvent,
): ChannelSubscriptionCatalog | undefined {
  return (onEvent as { [CATALOG]?: ChannelSubscriptionCatalog })[CATALOG];
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
