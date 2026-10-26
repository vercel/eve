import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { StreamReconnectPolicy } from "#client/types.js";

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
  readonly streamReconnectPolicy?: StreamReconnectPolicy;
}

/** A read-only session handle. Attaching it performs no I/O and grants no command authority. */
export interface SessionReader {
  readonly id: string;
  stream(options?: SessionStreamOptions): AsyncIterable<SessionStreamEvent>;
}
