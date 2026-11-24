export interface SessionEventStore {
  readable(sessionId: string, startIndex?: number): ReadableStream<Uint8Array>;
  tail(sessionId: string): Promise<number>;
  assertFollowable(sessionId: string): Promise<void>;
}
