import type { MessageStreamEvent } from "#protocol/message.js";
import { extractCompletedResult } from "#client/output-schema.js";
import { summarizeTurnEvents } from "#client/session-utils.js";
import type { MessageResult } from "#client/types.js";

/**
 * Internal configuration passed to construct a {@link MessageResponse}.
 */
interface MessageResponseInput {
  readonly continuationToken?: string;
  readonly createStream: () => AsyncGenerator<MessageStreamEvent>;
  readonly sessionId: string;
}

/**
 * The response from {@link ClientSession.send}.
 *
 * Like `fetch()`, the response exposes metadata (session ID, continuation
 * token) as soon as the POST completes. Collect the event stream via
 * {@link result} or iterate it with `for await...of`.
 */
export class MessageResponse<TOutput = unknown> implements AsyncIterable<MessageStreamEvent> {
  /**
   * Continuation token returned by the server for follow-up messages.
   */
  readonly continuationToken: string | undefined;

  /**
   * Session ID assigned by the server.
   */
  readonly sessionId: string;

  #consumed = false;
  readonly #createStream: () => AsyncGenerator<MessageStreamEvent>;

  /** @internal */
  constructor(input: MessageResponseInput) {
    this.continuationToken = input.continuationToken;
    this.sessionId = input.sessionId;
    this.#createStream = input.createStream;
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

    return this.#createStream();
  }
}
