import type { SessionStreamEvent } from "#protocol/session-event.js";
import { turnSummary } from "#client/session-utils.js";
import { throwIfAborted } from "#client/abort-signal.js";
import type { Delivery, DeliveryReadOptions, DeliveryResult } from "#shared/delivery.js";
export type { Delivery } from "#shared/delivery.js";

/**
 * @internal When the client sent an accepted message or answer, in epoch
 * milliseconds on the client's clock.
 */
export interface ClientSendReceipt {
  readonly deliveryId?: string;
  /** The first attempt was issued. */
  readonly startedAt: number;
  /** Retrying `409 session_not_ready` before the accepted attempt was issued. */
  readonly notReadyMs: number;
  /** The accepted response arrived. */
  readonly acceptedAt: number;
}

interface DeliveryInput {
  readonly inbox?: string;
  readonly createStream: (options?: DeliveryReadOptions) => AsyncIterable<SessionStreamEvent>;
  readonly deliveryId: string;
  readonly receipt?: ClientSendReceipt;
  readonly sessionId: string;
}

const sendReceipts = new WeakMap<Delivery, ClientSendReceipt>();

/** An accepted command: its receipt and independent reads through its own settlement. */
export class StreamDelivery<TOutput = unknown> implements Delivery<TOutput> {
  readonly sessionId: string;
  readonly deliveryId: string;
  readonly inbox?: string;
  readonly #createStream: DeliveryInput["createStream"];
  #result: DeliveryResult<TOutput> | undefined;

  /** @internal */
  constructor(input: DeliveryInput) {
    this.sessionId = input.sessionId;
    this.inbox = input.inbox;
    this.deliveryId = input.deliveryId;
    if (input.receipt !== undefined) sendReceipts.set(this, input.receipt);
    this.#createStream = input.createStream;
  }

  /** Independent, replayable read; exiting it never consumes the handle. */
  async *stream(options?: DeliveryReadOptions): AsyncGenerator<SessionStreamEvent> {
    throwIfAborted(options?.signal);
    for await (const event of this.#createStream(options)) {
      throwIfAborted(options?.signal);
      yield event;
    }
    throwIfAborted(options?.signal);
  }

  /** Caches only a completed summary; failed/aborted reads can be retried. */
  async result(options?: DeliveryReadOptions): Promise<DeliveryResult<TOutput>> {
    throwIfAborted(options?.signal);
    if (this.#result !== undefined) return this.#result;
    const accumulator = turnSummary(this.deliveryId);
    for await (const event of this.stream(options)) accumulator.observe(event);
    const summary = accumulator.result();
    if (summary.status === "working" || summary.outcome === undefined) {
      throw new Error("The stream ended before the accepted delivery settled.");
    }
    const data = {
      data: summary.result as TOutput | undefined,
      deliveryId: this.deliveryId,
      interactions: summary.interactions,
      outcome: summary.outcome,
      reply: summary.message,
      sessionEnded: summary.sessionEnded,
      sessionId: this.sessionId,
    };
    const result: DeliveryResult<TOutput> =
      summary.status === "failed"
        ? {
            ...data,
            status: "failed",
            error: summary.failure ?? { code: "DELIVERY_FAILED", message: "The delivery failed." },
          }
        : { ...data, status: summary.status };
    this.#result = result;
    return result;
  }
}

/** @internal Returns when the client sent the delivery's request, if it sent it. */
export function getDeliveryReceipt(delivery: Delivery): ClientSendReceipt | undefined {
  return sendReceipts.get(delivery);
}
