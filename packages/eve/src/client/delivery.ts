import type { SessionStreamEvent } from "#protocol/session-event.js";
import { summarizeTurnEvents } from "#client/session-utils.js";
import type { Delivery, DeliveryResult } from "#shared/delivery.js";
export type { Delivery } from "#shared/delivery.js";

interface DeliveryInput {
  readonly createStream: () => AsyncIterable<SessionStreamEvent>;
  readonly deliveryId: string;
  readonly sessionId: string;
}

/** An accepted command: its receipt and the stream through its own settlement. */
export class StreamDelivery<TOutput = unknown> implements Delivery<TOutput> {
  readonly sessionId: string;
  readonly deliveryId: string;
  readonly #createStream: DeliveryInput["createStream"];
  #consumed = false;
  #result: Promise<DeliveryResult<TOutput>> | undefined;

  /** @internal */
  constructor(input: DeliveryInput) {
    this.sessionId = input.sessionId;
    this.deliveryId = input.deliveryId;
    this.#createStream = input.createStream;
  }

  /** Reads this delivery's settlement, not the end of its session. Consumes the stream. */
  result(): Promise<DeliveryResult<TOutput>> {
    return (this.#result ??= this.#collect());
  }

  async #collect(): Promise<DeliveryResult<TOutput>> {
    const events: SessionStreamEvent[] = [];
    for await (const event of this) events.push(event);
    const summary = summarizeTurnEvents(events, this.deliveryId);
    return {
      data: summary.result as TOutput | undefined,
      deliveryId: this.deliveryId,
      events,
      interactions: summary.interactions,
      reply: summary.message,
      sessionEnded: summary.sessionEnded,
      sessionId: this.sessionId,
      status: summary.status,
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionStreamEvent> {
    if (this.#consumed) throw new Error("Delivery has already been consumed.");
    this.#consumed = true;
    return this.#createStream()[Symbol.asyncIterator]();
  }
}
