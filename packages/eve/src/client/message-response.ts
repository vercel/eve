import { isCurrentTurnBoundaryEvent, type MessageStreamEvent } from "#protocol/message.js";
import { extractCompletedResult } from "#client/output-schema.js";
import { summarizeTurnEvents } from "#client/session-utils.js";
import type { CancelSessionResult, MessageResult } from "#client/types.js";

/**
 * Internal configuration passed to construct a {@link MessageResponse}.
 */
interface MessageResponseInput {
  readonly cancelTurn: (turnId: string) => Promise<CancelSessionResult>;
  readonly createStream: () => AsyncGenerator<MessageStreamEvent>;
  readonly sessionId: string;
}

/**
 * The response from {@link ClientSession.send}.
 *
 * Like `fetch()`, the response exposes its session ID as soon as the POST
 * completes. Collect the event stream via
 * {@link result} or iterate it with `for await...of`.
 */
export class MessageResponse<TOutput = unknown> implements AsyncIterable<MessageStreamEvent> {
  /**
   * Session ID assigned by the server.
   */
  readonly sessionId: string;

  readonly #cancelTurn: (turnId: string) => Promise<CancelSessionResult>;
  #cancellation: Promise<CancelSessionResult> | undefined;
  #consumed = false;
  readonly #createStream: () => AsyncGenerator<MessageStreamEvent>;
  #settled = false;
  readonly #turnId = Promise.withResolvers<string | undefined>();

  /** @internal */
  constructor(input: MessageResponseInput) {
    this.#cancelTurn = input.cancelTurn;
    this.sessionId = input.sessionId;
    this.#createStream = input.createStream;
  }

  /**
   * Requests cooperative cancellation of this exact turn.
   *
   * The request waits for the response stream to identify the turn when
   * necessary. Continue consuming the stream to observe its durable boundary.
   */
  cancel(): Promise<CancelSessionResult> {
    if (this.#settled) return Promise.resolve({ status: "no_active_turn" });
    if (this.#cancellation !== undefined) return this.#cancellation;

    const cancellation = this.#turnId.promise.then<CancelSessionResult>((turnId) =>
      turnId === undefined ? { status: "no_active_turn" } : this.#cancelTurn(turnId),
    );
    this.#cancellation = cancellation;
    void cancellation.catch(() => {
      if (!this.#settled && this.#cancellation === cancellation) this.#cancellation = undefined;
    });
    return cancellation;
  }

  /**
   * Consumes the full event stream and returns the aggregated
   * {@link MessageResult}.
   */
  async result(): Promise<MessageResult<TOutput>> {
    const events: MessageStreamEvent[] = [];

    for await (const event of this) {
      events.push(event);
    }

    const summary = summarizeTurnEvents(events);
    return {
      data: extractCompletedResult<TOutput>(events),
      events,
      inputRequests: summary.inputRequests,
      message: summary.message,
      sessionId: this.sessionId,
      status: summary.status,
    };
  }

  /**
   * Yields stream events one at a time.
   *
   * Each response can only be consumed once.
   */
  [Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
    if (this.#consumed) {
      throw new Error("MessageResponse has already been consumed.");
    }
    this.#consumed = true;

    return this.#observeStream();
  }

  async *#observeStream(): AsyncGenerator<MessageStreamEvent> {
    try {
      for await (const event of this.#createStream()) {
        if (event.type === "turn.started") {
          this.#turnId.resolve(event.data.turnId);
        } else if (isCurrentTurnBoundaryEvent(event)) {
          this.#settled = true;
          this.#turnId.resolve(undefined);
        }
        yield event;
      }
    } finally {
      this.#turnId.resolve(undefined);
    }
  }
}
