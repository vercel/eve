/**
 * Where a session's stream is stored: one encoded line per chunk, as the session's writer wrote
 * them, so a chunk's index is its line's position. Each host keeps the streams of the sessions it runs
 * (`#execution/hosts.js` finds a session's).
 */
export interface SessionLineStore {
  /**
   * The stream's chunks from `startIndex`, following writes until the stream closes. A negative
   * `startIndex` counts back from the tail.
   */
  readable(sessionId: string, startIndex?: number): ReadableStream<Uint8Array>;
  /**
   * The position of the last line stored, or `-1` before the first. Throws as
   * {@link assertReadable} does.
   */
  tail(sessionId: string): Promise<number>;
  /** Throws when the session's stream doesn't exist or its history has passed retention. */
  assertReadable(sessionId: string): Promise<void>;
}
