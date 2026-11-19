import type { JsonObject } from "#shared/json.js";

/**
 * One event a channel lets a session subscribe to. The model reads `description` and
 * `inputSchema` on the subscribe tool eve generates for the event, and the channel's routes call
 * `publish(event, input, delivery)` with an `input` shaped by the same schema.
 */
export interface ChannelEventDefinition {
  /** What the event reports, written for the model that decides whether to subscribe. */
  readonly description: string;
  /** JSON Schema of the arguments that pick which occurrences the subscriber hears about. */
  readonly inputSchema: JsonObject;
  /**
   * Rewrites arguments into one canonical form before eve compares a subscription to a
   * published event, such as lowercasing a name the platform treats case-insensitively. Runs on
   * both sides, so it has to be deterministic.
   */
  readonly normalize?: (input: JsonObject) => JsonObject;
}

/** Events a channel offers, keyed by event name (letters, digits and underscores). */
export type ChannelSubscriptions = Readonly<Record<string, ChannelEventDefinition>>;

/** What a route hands to `publish`: a stable id for deduplication and the text the subscriber receives. */
export interface ChannelEventDelivery {
  /** Identifies the occurrence, so a redelivery of the same one reaches the subscriber once. */
  readonly id: string;
  /** Sent to the subscribing session as a queued message under the subscriber's own auth. */
  readonly message: string;
}

/**
 * Hands one occurrence of a channel event to the session that subscribed to it. Resolves `true`
 * when a subscription matched `input` and `false` when nobody is subscribed.
 */
export type PublishChannelEventFn = (
  event: string,
  input: JsonObject,
  delivery: ChannelEventDelivery,
) => Promise<boolean>;

export const CHANNEL_EVENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export function assertChannelSubscriptions(subscriptions: ChannelSubscriptions | undefined): void {
  for (const name of Object.keys(subscriptions ?? {})) {
    if (!CHANNEL_EVENT_NAME_PATTERN.test(name))
      throw new Error(
        `Channel subscription event "${name}" must start with a letter and use only letters, digits and underscores.`,
      );
  }
}
