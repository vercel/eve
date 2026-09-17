import { followClientSession, type ClientSession } from "#client/session.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { StreamOptions } from "#client/types.js";

export interface SessionEventStreamOptions {
  readonly startIndex?: number;
  readonly catchUp?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly streamReconnectPolicy?: StreamOptions["streamReconnectPolicy"];
  readonly onEvent: (event: MessageStreamEvent) => void;
  readonly onError: (error: unknown) => void;
}

/** One transport, with short-lived readers for catch-up and turn completion. */
export class SessionEventStream {
  readonly #controller = new AbortController();
  readonly #readers = new Set<SessionEventReader>();
  readonly #caughtUp = Promise.withResolvers<void>();
  readonly caughtUp = this.#caughtUp.promise;
  #ended = false;
  #error: unknown;
  #headers: Readonly<Record<string, string>> | undefined;

  constructor(session: ClientSession, options: SessionEventStreamOptions) {
    this.#headers = options.headers;
    void this.caughtUp.catch(() => {});
    if (!options.catchUp) this.#caughtUp.resolve();
    void (async () => {
      try {
        for await (const event of followClientSession(session, {
          signal: this.#controller.signal,
          resolveHeaders: () => this.#headers,
          streamReconnectPolicy: options.streamReconnectPolicy,
          startIndex: options.startIndex,
          onCaughtUp: options.catchUp ? () => this.#caughtUp.resolve() : undefined,
        })) {
          if (this.#controller.signal.aborted) return;
          options.onEvent(event);
          for (const reader of this.#readers) reader.push(event);
          if (event.type === "session.completed" || event.type === "session.failed") break;
        }
        this.#caughtUp.resolve();
        this.#finish();
      } catch (error) {
        this.#caughtUp.reject(error);
        this.#finish(error);
        if (!this.#controller.signal.aborted) options.onError(error);
      }
    })();
  }

  subscribe(signal?: AbortSignal): SessionEventReader {
    const reader = new SessionEventReader(() => this.#readers.delete(reader), signal);
    if (this.#ended) reader.end(this.#error);
    else this.#readers.add(reader);
    return reader;
  }

  get ended(): boolean {
    return this.#ended;
  }

  setHeaders(headers: Readonly<Record<string, string>> | undefined): void {
    this.#headers = headers;
  }

  close(): void {
    const error = new DOMException("Session stream was detached.", "AbortError");
    this.#controller.abort(error);
    this.#caughtUp.reject(error);
    this.#finish(error);
  }

  #finish(error?: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    for (const reader of this.#readers) reader.end(error);
  }
}

export class SessionEventReader implements AsyncIterable<MessageStreamEvent>, Disposable {
  #events: MessageStreamEvent[] = [];
  #wake = Promise.withResolvers<void>();
  #ended = false;
  #error: unknown;
  readonly #dispose: () => void;

  constructor(unsubscribe: () => void, signal?: AbortSignal) {
    const abort = () => this.end(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    this.#dispose = () => {
      signal?.removeEventListener("abort", abort);
      unsubscribe();
    };
    if (signal?.aborted) abort();
  }

  push(event: MessageStreamEvent): void {
    if (this.#ended) return;
    this.#events.push(event);
    this.#wake.resolve();
  }

  end(error?: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    this.#wake.resolve();
  }

  [Symbol.dispose](): void {
    this.end();
    this.#events = [];
    this.#dispose();
  }

  discard(): void {
    this.#events = [];
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<MessageStreamEvent> {
    for (;;) {
      while (this.#events.length > 0) yield this.#events.shift()!;
      if (this.#ended) {
        if (this.#error !== undefined) throw this.#error;
        return;
      }
      this.#wake = Promise.withResolvers<void>();
      await this.#wake.promise;
    }
  }
}
