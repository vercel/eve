// Durable entities: what eve needs a World to keep, as one interface, so an implementation
// Workflow ships natively can replace ours (`world/`) by passing the same conformance suite
// (`entities.conformance.ts`). Nothing here names how a World implements it: no runs, events,
// cursors or streams by name.
//
// An entity has a key and what it was created with (`meta`). It has:
//   - a journal: records appended in order, from its latest snapshot on (its state);
//   - a stream: append-only output, readable by anyone, from any position;
//   - one writer at a time: opening it fences out whoever wrote it before.
//
// Guarantees an implementation keeps (and the conformance suite checks):
//   1. One writer: opening a handle fences out earlier handles; their writes (journal, stream)
//      fail with `TakenOverError` from then on, and write nothing.
//   2. A record is durable when `append` resolves; `load` returns the latest snapshot and every
//      record after it, in order, and costs what it returns.
//   3. A stream chunk is readable everywhere once `append` resolves; a reader starts at any
//      position, follows live, and costs what it reads.

/** One record of an entity's journal. */
export interface JournalRecord {
  readonly kind: string;
  readonly value: unknown;
}

/** What an entity's journal holds: its latest snapshot and the records after it. */
export interface LoadedJournal {
  /** The latest record appended as a snapshot, if any. */
  readonly snapshot: JournalRecord | undefined;
  /** The records after it, oldest first. */
  readonly after: readonly JournalRecord[];
}

/** Another writer opened the entity: this one's writes are refused. */
export class TakenOverError extends Error {
  override readonly name = "TakenOverError";
  readonly key: string;
  constructor(key: string, options?: { readonly cause?: unknown }) {
    super(`"${key}" was continued by another process, so this one no longer writes it.`, options);
    this.key = key;
  }
}

/** Whether `error`, or one of its causes, is a `TakenOverError`. */
export function isTakenOver(error: unknown): boolean {
  for (let cause = error, depth = 0; cause instanceof Error && depth < 10; depth += 1) {
    if (cause instanceof TakenOverError) return true;
    cause = cause.cause;
  }
  return false;
}

/** Entities of one kind on one World. Keys are `<kind>_` and a ULID (`newKey`). */
export interface Entities {
  /** A key for a new entity. */
  newKey(): string;
  /** Creates `key` with what it starts from (`meta`, which never changes). Refused if it exists. */
  create(key: string, options: { readonly meta: unknown }): Promise<void>;
  /** What `key` was created with, or `undefined` when no such entity exists. */
  meta(key: string): Promise<unknown>;
  /** Opens `key` for writing here, creating it (with no meta) if it doesn't exist. */
  open(key: string): Promise<EntityHandle>;
  /** `key`'s journal, without opening it; `undefined` when no such entity exists. */
  load(key: string): Promise<LoadedJournal | undefined>;
  /** How many chunks `key`'s stream holds. */
  streamLength(key: string): Promise<number>;
  /** Every chunk `key`'s stream holds now, without following it. */
  chunks(key: string): Promise<readonly Uint8Array[]>;
  /** Reads `key`'s stream from `from` (negative: before its end), following it live. */
  read(key: string, from?: number): ReadableStream<Uint8Array>;
  /** Every entity of this kind, newest first. */
  list(): Promise<readonly { readonly key: string; readonly createdAt: Date }[]>;
}

/** One writer's hold on an entity. Every write fails with `TakenOverError` once fenced out. */
export interface EntityHandle {
  readonly key: string;
  /** What it was created with (`Entities.create`'s `meta`). */
  readonly meta: unknown;
  /** Its journal, as `Entities.load`. */
  load(): Promise<LoadedJournal>;
  /** Appends `records` in order. With `snapshot`, the last one is the snapshot later loads start from. */
  append(
    records: readonly JournalRecord[],
    options?: { readonly snapshot?: boolean },
  ): Promise<void>;
  /** The stream, written only by this handle. */
  readonly stream: {
    length(): Promise<number>;
    /** Appends `chunks`, the first at `position`, which must be the stream's length. */
    append(position: number, chunks: readonly Uint8Array[]): Promise<void>;
  };
}
