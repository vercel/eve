import type { Answer } from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";
import type { MessageContent } from "#shared/message-content.js";

/** One inbound delivery passed to a channel's `deliver` hook. */
export interface ChannelDelivery<TState = undefined> {
  readonly message?: MessageContent;
  readonly answers?: readonly Answer[];
  /** Context persisted in history before this delivery's message. */
  readonly context?: readonly string[];
  /** JSON schema the turn's result must match. */
  readonly outputSchema?: JsonObject;
  /** Per-delivery state; the hook chooses what to merge into durable channel state. */
  readonly state?: Partial<TState>;
}

/** What a `deliver` hook may return. Channel state changes go through `channel.state`. */
export type ChannelDeliveryReplacement = Omit<ChannelDelivery, "state">;
