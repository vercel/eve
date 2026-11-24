export interface SessionEventStore {
  readable(sessionId: string, startIndex?: number): ReadableStream<Uint8Array>;
  tail(sessionId: string): Promise<number>;
  assertReadable(sessionId: string): Promise<void>;
}
