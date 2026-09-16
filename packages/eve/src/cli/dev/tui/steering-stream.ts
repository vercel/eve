import { createEventDeduper } from "#protocol/event-dedupe.js";
import { isCurrentTurnBoundaryEvent, type MessageStreamEvent } from "#protocol/message.js";

/**
 * Follows accepted messages through their boundary, including a send racing
 * settlement. Delivery responses may overlap; stream event IDs deduplicate them.
 */
export class SteeringStream implements AsyncIterable<MessageStreamEvent> {
  private readonly session: {
    cancel(options?: { signal?: AbortSignal; turnId?: string }): Promise<unknown>;
    send(
      message: string,
      options: { turnPolicy: "steer"; signal: AbortSignal },
    ): Promise<AsyncIterable<MessageStreamEvent>>;
  };
  private readonly streams: Promise<AsyncIterable<MessageStreamEvent> | undefined>[];
  private assistantOutputStarted = false;
  private closed = false;
  private readonly controller = new AbortController();
  private restartRequested = false;
  private turnId: string | undefined;

  constructor(initial: AsyncIterable<MessageStreamEvent>, session: SteeringStream["session"]) {
    this.session = session;
    this.streams = [Promise.resolve(initial)];
  }

  async send(message: string): Promise<void> {
    if (this.closed) throw new Error("The active stream ended before steering was sent.");
    if (!this.assistantOutputStarted && !this.restartRequested) {
      this.restartRequested = true;
      await this.session
        .cancel({ signal: this.controller.signal, turnId: this.turnId })
        .catch(() => undefined);
    }
    const response = this.session.send(message, {
      turnPolicy: "steer",
      signal: this.controller.signal,
    });
    // Handle failure immediately even if the initial stream has not finished.
    this.streams.push(
      response.then(
        (value) => value,
        () => undefined,
      ),
    );
    await response;
  }

  abort(): void {
    this.closed = true;
    this.controller.abort();
  }

  isRestartCancellation(turnId: string): boolean {
    return this.restartRequested && (this.turnId === undefined || this.turnId === turnId);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<MessageStreamEvent> {
    const seen = createEventDeduper();
    let boundary: MessageStreamEvent | undefined;
    try {
      while (this.streams.length > 0) {
        const stream = await this.streams.shift()!;
        if (stream === undefined) continue;
        for await (const event of stream) {
          if (!seen.admit(event)) continue;
          if (event.type === "turn.started") {
            if (this.turnId !== undefined && event.data.turnId !== this.turnId) {
              this.assistantOutputStarted = false;
              this.restartRequested = false;
            }
            this.turnId = event.data.turnId;
          }
          if (
            event.type === "message.appended" ||
            event.type === "message.completed" ||
            event.type === "result.completed"
          ) {
            this.assistantOutputStarted = true;
          }
          if (isCurrentTurnBoundaryEvent(event)) {
            boundary = event;
            break;
          }
          yield event;
        }
      }
      if (boundary !== undefined) yield boundary;
    } finally {
      this.abort();
    }
  }
}
