import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { isCurrentTurnBoundaryEvent } from "#protocol/message.js";

function isDevelopmentMessageStreamDisconnectError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const errorCode = "code" in error && typeof error.code === "string" ? error.code : undefined;

  return (
    error.name === "AbortError" ||
    error.message === "terminated" ||
    errorCode === "UND_ERR_SOCKET" ||
    /abort|cancel|disconnect|premature close|socket|terminated/i.test(error.message)
  );
}

/**
 * One reusable service-owned connection to a durable message-run stream.
 */
export interface DevelopmentMessageStream {
  /**
   * Absolute stream URL used to open this connection.
   */
  readonly resourceUrl: string;
  /**
   * Whether the underlying response body can no longer produce future events.
   */
  readonly closed: boolean;

  /**
   * Stops reading from the underlying response and releases any held reader.
   */
  close(): Promise<void>;

  /**
   * Reads one slice of newline-delimited events from the stream until the
   * configured boundary predicate matches or the response closes.
   */
  readEvents(input: {
    onEvent?(event: HandleMessageStreamEvent): void;
    startAfterBoundaryCount?: number;
    stopWhen?(event: HandleMessageStreamEvent): boolean;
  }): Promise<HandleMessageStreamEvent[]>;
}

class BufferedDevelopmentMessageStream implements DevelopmentMessageStream {
  readonly resourceUrl: string;

  #boundaryCount = 0;
  #buffer = "";
  #closed = false;
  readonly #decoder = new TextDecoder();
  #isReading = false;
  #reader: ReadableStreamDefaultReader<Uint8Array> | null;

  constructor(input: { boundaryCount?: number; resourceUrl: string; response: Response }) {
    this.resourceUrl = input.resourceUrl;
    this.#boundaryCount = input.boundaryCount ?? 0;
    this.#reader = input.response.body?.getReader() ?? null;
    this.#closed = this.#reader === null;

    if (this.#reader) {
      void this.#reader.closed
        .catch(() => undefined)
        .finally(() => {
          this.#closed = true;
        });
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  async close(): Promise<void> {
    const reader = this.#reader;

    this.#closed = true;
    this.#reader = null;
    this.#buffer = "";

    if (reader === null) {
      return;
    }

    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }

  async readEvents(input: {
    onEvent?(event: HandleMessageStreamEvent): void;
    startAfterBoundaryCount?: number;
    stopWhen?(event: HandleMessageStreamEvent): boolean;
  }): Promise<HandleMessageStreamEvent[]> {
    if (this.#closed) {
      return [];
    }

    if (this.#isReading) {
      throw new Error("Development message stream does not support concurrent reads.");
    }

    const reader = this.#reader;

    if (reader === null) {
      return [];
    }

    this.#isReading = true;

    try {
      const events: HandleMessageStreamEvent[] = [];
      const stopWhen = input.stopWhen ?? isCurrentTurnBoundaryEvent;
      const startAfterBoundaryCount = input.startAfterBoundaryCount ?? 0;
      let shouldCollect = startAfterBoundaryCount <= this.#boundaryCount;

      const handleEvent = (event: HandleMessageStreamEvent): boolean => {
        const isBoundaryEvent = isCurrentTurnBoundaryEvent(event);

        if (shouldCollect) {
          events.push(event);
          input.onEvent?.(event);
        }

        if (!isBoundaryEvent) {
          return false;
        }

        this.#boundaryCount += 1;

        if (!shouldCollect && this.#boundaryCount >= startAfterBoundaryCount) {
          shouldCollect = true;
          return false;
        }

        return shouldCollect && stopWhen(event);
      };

      while (true) {
        while (true) {
          const newlineIndex = this.#buffer.indexOf("\n");

          if (newlineIndex === -1) {
            break;
          }

          const line = this.#buffer.slice(0, newlineIndex).trim();
          this.#buffer = this.#buffer.slice(newlineIndex + 1);

          if (line.length === 0) {
            continue;
          }

          const event = JSON.parse(line) as HandleMessageStreamEvent;

          if (handleEvent(event)) {
            return events;
          }
        }

        if (this.#closed) {
          break;
        }

        let done = false;
        let value: Uint8Array | undefined;

        try {
          const readResult = await reader.read();
          done = readResult.done;
          value = readResult.value;
        } catch (error) {
          if (!isDevelopmentMessageStreamDisconnectError(error)) {
            throw error;
          }

          // Discard any incomplete trailing line and reconnect from the last
          // fully parsed event via the durable stream cursor.
          this.#buffer = "";
          this.#closed = true;
          break;
        }

        if (done) {
          this.#buffer += this.#decoder.decode();
          this.#closed = true;
          continue;
        }

        if (!value) {
          continue;
        }

        this.#buffer += this.#decoder.decode(value, {
          stream: true,
        });
      }

      const trailingLine = this.#buffer.trim();
      this.#buffer = "";

      if (trailingLine.length > 0) {
        const event = JSON.parse(trailingLine) as HandleMessageStreamEvent;
        handleEvent(event);
      }

      return events;
    } finally {
      this.#isReading = false;

      if (this.#closed) {
        reader.releaseLock();
        this.#reader = null;
      }
    }
  }
}

/**
 * Opens one reusable message-stream reader for the development client.
 */
export function openDevelopmentMessageStream(input: {
  boundaryCount?: number;
  resourceUrl: string;
  response: Response;
}): DevelopmentMessageStream {
  return new BufferedDevelopmentMessageStream(input);
}
