import type { SessionStreamEvent } from "#protocol/session-event.js";
import { createEventReader } from "#protocol/session-lines.js";
import { endsTurn } from "#client/session-utils.js";
import { isStreamDisconnectError, readNdjsonStream } from "#client/ndjson.js";
import type { ReadRecord } from "#protocol/session-events/envelope.js";

/** One reusable service-owned connection to a durable session-line stream. */
export interface DevelopmentMessageStream {
  readonly resourceUrl: string;
  readonly closed: boolean;
  close(): Promise<void>;
  readEvents(input: {
    onEvent?(event: SessionStreamEvent): void;
    startAfterBoundaryCount?: number;
    stopWhen?(event: SessionStreamEvent): boolean;
  }): Promise<SessionStreamEvent[]>;
}

class BufferedDevelopmentMessageStream implements DevelopmentMessageStream {
  readonly resourceUrl: string;
  readonly #records: AsyncGenerator<ReadRecord> | undefined;
  readonly #abort = new AbortController();
  readonly #eventReader = createEventReader();
  #boundaryCount: number;
  #position = 0;
  #closed = false;
  #isReading = false;

  constructor(input: { boundaryCount?: number; resourceUrl: string; response: Response }) {
    this.resourceUrl = input.resourceUrl;
    this.#boundaryCount = input.boundaryCount ?? 0;
    this.#records =
      input.response.body === null
        ? undefined
        : readNdjsonStream(input.response.body, { signal: this.#abort.signal });
    this.#closed = this.#records === undefined;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#abort.abort();
    await this.#records?.return(undefined).catch(() => {});
  }

  async readEvents(input: {
    onEvent?(event: SessionStreamEvent): void;
    startAfterBoundaryCount?: number;
    stopWhen?(event: SessionStreamEvent): boolean;
  }): Promise<SessionStreamEvent[]> {
    if (this.#closed || this.#records === undefined) return [];
    if (this.#isReading)
      throw new Error("Development message stream does not support concurrent reads.");
    this.#isReading = true;
    const events: SessionStreamEvent[] = [];
    const stopWhen = input.stopWhen ?? endsTurn;
    const startAfter = input.startAfterBoundaryCount ?? 0;
    let collect = startAfter <= this.#boundaryCount;
    try {
      while (!this.#closed) {
        const next = await this.#records.next();
        if (next.done) {
          this.#closed = true;
          break;
        }
        const record = next.value;
        if (record.kind === "transport") {
          if (record.record.$eve === "position") this.#position = record.record.next;
          else if (record.record.$eve === "stream.ended") this.#closed = true;
          continue;
        }
        if (record.kind === "unknown-transport") continue;
        const position = this.#position++;
        if (record.kind === "invalid") continue;
        const lineEvents = this.#eventReader.read(record.line, position);
        let boundary = false;
        let stop = false;
        for (const event of lineEvents) {
          if (collect) {
            events.push(event);
            input.onEvent?.(event);
          }
          boundary ||= endsTurn(event);
          stop ||= collect && stopWhen(event);
        }
        if (boundary) {
          this.#boundaryCount += 1;
          if (!collect && this.#boundaryCount >= startAfter) collect = true;
        }
        // Consume the whole commit before stopping, including its terminal session fact.
        if (stop) return events;
      }
      return events;
    } catch (error) {
      if (!isStreamDisconnectError(error)) throw error;
      this.#closed = true;
      return events;
    } finally {
      this.#isReading = false;
    }
  }
}

export function openDevelopmentMessageStream(input: {
  boundaryCount?: number;
  resourceUrl: string;
  response: Response;
}): DevelopmentMessageStream {
  return new BufferedDevelopmentMessageStream(input);
}
