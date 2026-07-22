import type { TimedHandleMessageStreamEvent } from "#protocol/message.js";

export interface LoopEventPublication {
  readonly encoded: Uint8Array;
  readonly event: TimedHandleMessageStreamEvent;
  readonly publicationKey: string;
}

export type EventPublicationReceipt =
  | { readonly kind: "inserted"; readonly streamOrdinal: number }
  | { readonly kind: "duplicate"; readonly streamOrdinal: number };

interface StoredPublication extends LoopEventPublication {
  readonly streamOrdinal: number;
}

interface StreamReader {
  readonly controller: ReadableStreamDefaultController<TimedHandleMessageStreamEvent>;
  nextOrdinal: number;
}

/** Process-local replayable event log for inline and local Temporal runs. */
export class InMemoryLoopEventLog {
  readonly #byKey = new Map<string, StoredPublication>();
  readonly #publications: StoredPublication[] = [];
  readonly #readers = new Set<StreamReader>();
  #terminal:
    | { readonly kind: "closed" }
    | { readonly error: unknown; readonly kind: "failed" }
    | null = null;

  append(publication: LoopEventPublication): EventPublicationReceipt {
    this.#assertOpen();
    if (publication.publicationKey.trim().length === 0) {
      throw new TypeError("Event publication key must be a non-empty string.");
    }

    const existing = this.#byKey.get(publication.publicationKey);
    if (existing !== undefined) {
      if (!equalBytes(existing.encoded, publication.encoded)) {
        throw new Error(
          `Event publication "${publication.publicationKey}" was replayed with different bytes.`,
        );
      }
      return { kind: "duplicate", streamOrdinal: existing.streamOrdinal };
    }

    const stored: StoredPublication = {
      ...publication,
      streamOrdinal: this.#publications.length,
    };
    this.#publications.push(stored);
    this.#byKey.set(stored.publicationKey, stored);
    for (const reader of this.#readers) this.#pump(reader);
    return { kind: "inserted", streamOrdinal: stored.streamOrdinal };
  }

  close(): void {
    if (this.#terminal !== null) return;
    this.#terminal = { kind: "closed" };
    for (const reader of this.#readers) this.#pump(reader);
  }

  fail(error: unknown): void {
    if (this.#terminal !== null) return;
    this.#terminal = { error, kind: "failed" };
    for (const reader of this.#readers) this.#pump(reader);
  }

  stream(startIndex = 0): ReadableStream<TimedHandleMessageStreamEvent> {
    if (!Number.isSafeInteger(startIndex)) {
      throw new TypeError("Event stream start index must be a safe integer.");
    }
    const nextOrdinal =
      startIndex < 0 ? Math.max(0, this.#publications.length + startIndex) : startIndex;

    let reader: StreamReader | undefined;
    return new ReadableStream<TimedHandleMessageStreamEvent>({
      cancel: () => {
        if (reader !== undefined) this.#readers.delete(reader);
      },
      pull: () => {
        if (reader !== undefined) this.#pump(reader);
      },
      start: (controller) => {
        reader = { controller, nextOrdinal };
        this.#readers.add(reader);
        this.#pump(reader);
      },
    });
  }

  #assertOpen(): void {
    if (this.#terminal !== null) throw new Error("Cannot append to a terminal event log.");
  }

  #pump(reader: StreamReader): void {
    while (reader.controller.desiredSize === null || reader.controller.desiredSize > 0) {
      const publication = this.#publications[reader.nextOrdinal];
      if (publication === undefined) break;
      reader.nextOrdinal += 1;
      reader.controller.enqueue(publication.event);
    }

    if (reader.nextOrdinal < this.#publications.length || this.#terminal === null) return;

    this.#readers.delete(reader);
    if (this.#terminal.kind === "failed") {
      reader.controller.error(this.#terminal.error);
    } else {
      reader.controller.close();
    }
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
