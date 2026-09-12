import { createEventDeduper } from "#protocol/event-dedupe.js";
import { isCurrentTurnBoundaryEvent, type MessageStreamEvent } from "#protocol/message.js";

/**
 * Follows accepted messages through their boundary, including a send racing
 * settlement. Delivery responses may overlap; stream event IDs deduplicate them.
 */
export class SteeringStream implements AsyncIterable<MessageStreamEvent> {
  private readonly session: {
    send(
      message: string,
      options: { turnPolicy: "steer"; signal: AbortSignal },
    ): Promise<AsyncIterable<MessageStreamEvent>>;
  };
  private readonly streams: Promise<AsyncIterable<MessageStreamEvent> | undefined>[];
  private closed = false;
  private readonly controller = new AbortController();

  constructor(initial: AsyncIterable<MessageStreamEvent>, session: SteeringStream["session"]) {
    this.session = session;
    this.streams = [Promise.resolve(initial)];
  }

  async send(message: string): Promise<void> {
    if (this.closed) throw new Error("The active stream ended before steering was sent.");
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

  async *[Symbol.asyncIterator](): AsyncGenerator<MessageStreamEvent> {
    const seen = createEventDeduper();
    let boundary: MessageStreamEvent | undefined;
    try {
      while (this.streams.length > 0) {
        const stream = await this.streams.shift()!;
        if (stream === undefined) continue;
        for await (const event of stream) {
          if (isCurrentTurnBoundaryEvent(event)) {
            boundary = event;
            break;
          }
          if (seen.admit(event)) yield event;
        }
      }
      if (boundary !== undefined) yield boundary;
    } finally {
      this.abort();
    }
  }
}
