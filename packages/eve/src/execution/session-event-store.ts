/** The stream of the events of sessions, which eve serves to clients. */
export interface SessionEventStore {
  /** Reads the stream of a session from `startIndex`, and follows new events. */
  readable(sessionId: string, startIndex?: number): ReadableStream<Uint8Array>;
  /** Returns the index of the last event of a session. */
  tail(sessionId: string): Promise<number>;
  /** Throws when the stream of a session cannot be followed. */
  assertFollowable(sessionId: string): Promise<void>;
}
