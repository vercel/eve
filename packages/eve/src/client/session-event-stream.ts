import type { SessionStreamEvent } from "#protocol/session-event.js";
import { followClientSession, type ClientSession } from "#client/session.js";
import type { SessionStreamOptions } from "#client/types.js";

export interface SessionEventStreamOptions {
  readonly startIndex?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly streamReconnectPolicy?: SessionStreamOptions["streamReconnectPolicy"];
  readonly onEvent: (event: SessionStreamEvent, historical: boolean) => void;
  readonly onError: (error: unknown) => void;
}

/** One continuously folded UI transport, independent of explicit Delivery reads. */
export class SessionEventStream {
  readonly #controller = new AbortController();
  readonly #caughtUp = Promise.withResolvers<void>();
  readonly caughtUp = this.#caughtUp.promise;
  #ended = false;
  #headers: SessionEventStreamOptions["headers"];
  #reconnectPolicy: SessionStreamOptions["streamReconnectPolicy"];

  constructor(session: ClientSession, options: SessionEventStreamOptions) {
    this.setOptions(options);
    void this.caughtUp.catch(() => {});
    void (async () => {
      let historical = true;
      try {
        for await (const event of followClientSession(session, {
          signal: this.#controller.signal,
          resolveHeaders: () => this.#headers,
          resolveReconnectPolicy: () => this.#reconnectPolicy,
          startIndex: options.startIndex,
          onCaughtUp: () => {
            historical = false;
            this.#caughtUp.resolve();
          },
        })) {
          if (this.#controller.signal.aborted) return;
          options.onEvent(event, historical);
          if (event.type === "session.ended") break;
        }
        this.#caughtUp.resolve();
      } catch (error) {
        this.#ended = true;
        this.#caughtUp.reject(error);
        if (!this.#controller.signal.aborted) options.onError(error);
      } finally {
        this.#ended = true;
      }
    })();
  }

  get ended(): boolean {
    return this.#ended;
  }

  setOptions(options: Pick<SessionEventStreamOptions, "headers" | "streamReconnectPolicy">): void {
    if ("headers" in options) this.#headers = options.headers;
    if ("streamReconnectPolicy" in options) this.#reconnectPolicy = options.streamReconnectPolicy;
  }

  close(): void {
    this.#ended = true;
    const error = new DOMException("Session stream was detached.", "AbortError");
    this.#controller.abort(error);
    this.#caughtUp.reject(error);
  }
}
