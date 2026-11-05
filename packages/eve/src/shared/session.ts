import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { ReconnectOptions } from "#client/types.js";
import type { TurnPolicy } from "#channel/types.js";
import type { Delivery } from "#shared/delivery.js";
import type { Answer } from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";
import type { MessageContent } from "#shared/message-content.js";

/** Options common to session readers on the client and server. */
export interface SessionStreamOptions {
  /**
   * Zero-based durable line position, matching `event.meta.position.line`,
   * not an event count. One line may contain several events. Negative values
   * count back from the tail (`-1` starts at the latest line). Defaults to `0`.
   */
  readonly startIndex?: number;
  /** Follow new lines (default), or stop at the durable tail observed on open. */
  readonly follow?: boolean;
  /** Stops the read and releases its stream reader. */
  readonly signal?: AbortSignal;
  /** Client-only reconnection policy; server-side readers do not reconnect. */
  readonly reconnect?: false | ReconnectOptions;
}

/** A read-only session handle. Attaching it performs no I/O and grants no command authority. */
export interface SessionReader {
  readonly id: string;
  stream(options?: SessionStreamOptions): AsyncIterable<SessionStreamEvent>;
}

/** Options every session handle's `send()` accepts, whatever carries it. */
export interface SessionSendTurnOptions {
  /** How the message treats a running turn. */
  readonly turnPolicy?: TurnPolicy;
  /** JSON Schema for a structured final answer. */
  readonly outputSchema?: JsonObject;
}

/** Options every session handle's `respond()` accepts, whatever carries it. */
export interface SessionRespondTurnOptions {
  /** JSON Schema for a structured final answer. */
  readonly outputSchema?: JsonObject;
}

/**
 * A session to talk to and control, whatever carries it: `eve/client`'s `ClientSession` over HTTP,
 * or a session running in this process (`eve/experimental/embed`, `eve/browser`). Each adds what
 * only its transport has.
 */
export interface SessionHandle extends SessionReader {
  /** Sends a message; the delivery streams the turn it starts or joins. */
  send(message: MessageContent, options?: SessionSendTurnOptions): Promise<Delivery>;
  /** Answers the session's open requests, such as approvals. */
  respond(answers: readonly Answer[], options?: SessionRespondTurnOptions): Promise<Delivery>;
  /** Cancels the running turn. */
  cancel(): Promise<Delivery>;
  /** Cancels a running turn and every working task, then removes the session's model history. */
  clear(): Promise<Delivery>;
  /** Queues context compaction without sending model input. */
  compact(): Promise<Delivery>;
  /** Ends the session for good. */
  end(): Promise<Delivery>;
}
