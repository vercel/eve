export class StreamReconnectExhaustedError extends Error {
  readonly maxReconnectAttempts: number;
  readonly sessionId: string;
  readonly streamIndex: number;

  constructor(input: {
    readonly maxReconnectAttempts: number;
    readonly sessionId: string;
    readonly streamIndex: number;
  }) {
    super(
      `eve stream ended before the current turn reached a boundary and the reconnect budget was exhausted. Reattach to session "${input.sessionId}" from stream index ${input.streamIndex}.`,
    );
    this.name = "StreamReconnectExhaustedError";
    this.maxReconnectAttempts = input.maxReconnectAttempts;
    this.sessionId = input.sessionId;
    this.streamIndex = input.streamIndex;
  }
}
