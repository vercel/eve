// Durable entities: what eve's World host needs a World to do, as one interface, so an
// implementation Workflow ships natively can replace ours (`world/`) by passing the same
// conformance suite (`entities.conformance.ts`). Nothing here names how a World implements it:
// no runs, hooks, events, cursors or queues.
//
// An entity has a key, and maybe aliases it's also reached by. It has:
//   - a journal: records appended in order, from its latest snapshot on (its state);
//   - a mailbox: messages anyone sends it, consumed exactly when the journal write that took them
//     is durable (`append`'s `consumedThrough`), so a crash in between delivers them again and a
//     crash after doesn't;
//   - a stream: append-only output, readable by anyone, live, from any position;
//   - one writer at a time: opening it fences out whoever wrote it before.
// With a queue (`activation`), an entity also runs only when something arrives for it or its
// alarm comes due: one activation at a time per key, until it's idle or its delivery's deadline.
//
// Guarantees an implementation keeps (and the conformance suite checks):
//   1. One writer: opening a handle fences out earlier handles; their writes (journal, stream,
//      consumption) fail with `TakenOverError` from then on, and write nothing.
//   2. One activation at a time per key; an activation that outlives its delivery is fenced (1).
//   3. A message is durable when `send` resolves, and is delivered in send order per key, until
//      a durable `append` consumes it. `dedupeKey` drops a repeated send.
//   4. Every message activates: one sent during an activation is read by it or by the next.
//   5. A record is durable when `append` resolves; `load` returns the latest snapshot and every
//      record after it, in order, and costs what it returns.
//   6. The alarm fires at or after its time, whatever the wait, and nothing activates the entity
//      for it before then.
//   7. A stream chunk is readable everywhere once `append` resolves; a reader starts at any
//      position, follows live, and costs what it reads.
//   8. `once` is true for exactly one caller per name and occurrence.

/** One record of an entity's journal. */
export interface JournalRecord {
  readonly kind: string;
  readonly value: unknown;
}

/** One message in an entity's mailbox. */
export interface EntityMessage {
  /** Opaque, and what `append`'s `consumedThrough` names. */
  readonly id: string;
  readonly body: unknown;
  /** The alias it was sent to, if it was sent to one. */
  readonly via?: string;
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

/** An alias another entity has already: `create` refuses it. */
export class AliasTakenError extends Error {
  override readonly name = "AliasTakenError";
  readonly alias: string;
  constructor(alias: string) {
    super(`Another entity is reached by "${alias}" already.`);
    this.alias = alias;
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
  /**
   * Creates `key` with what it starts from (`meta`, which never changes) and the aliases it's
   * also reached by. Refused if it exists, and with `AliasTakenError` if another entity has one
   * of the aliases (which then reaches that entity still). It doesn't run until something
   * activates it.
   */
  create(
    key: string,
    options: { readonly meta: unknown; readonly aliases?: readonly string[] },
  ): Promise<void>;
  /** What `key` was created with, or `undefined` when no such entity exists. */
  meta(key: string): Promise<unknown>;
  /** The entity an alias reaches, if any. */
  lookup(alias: string): Promise<string | undefined>;
  /**
   * Puts `body` in an entity's mailbox, addressed by key or by alias, from anywhere, then
   * activates it when there's a queue. Resolves once the message is durable; `undefined` when no
   * entity has that key or alias.
   */
  send(
    to: { readonly key: string } | { readonly alias: string },
    body: unknown,
    options?: { readonly dedupeKey?: string },
  ): Promise<{ readonly key: string } | undefined>;
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
  /** Whether this caller is the one that runs `name` for `occurrence`, across every process. */
  once(name: string, occurrence: number): Promise<boolean>;
  /** Present when the World has a queue: what runs entities when something arrives. */
  readonly activation?: Activation;
}

/** One writer's hold on an entity. Every write fails with `TakenOverError` once fenced out. */
export interface EntityHandle {
  readonly key: string;
  /** What it was created with (`Entities.create`'s `meta`). */
  readonly meta: unknown;
  /** Its journal, as `Entities.load`. */
  load(): Promise<LoadedJournal>;
  /**
   * Appends `records` in order. With `snapshot`, the last one is the snapshot later loads start
   * from. With `consumedThrough`, the mailbox is consumed through that message in the same write.
   */
  append(
    records: readonly JournalRecord[],
    options?: { readonly snapshot?: boolean; readonly consumedThrough?: string },
  ): Promise<void>;
  /** The mailbox's messages not yet consumed, oldest first. */
  inbox(): Promise<readonly EntityMessage[]>;
  /** The stream, written only by this handle. */
  readonly stream: {
    length(): Promise<number>;
    /** Appends `chunks`, the first at `position`, which must be the stream's length. */
    append(position: number, chunks: readonly Uint8Array[]): Promise<void>;
  };
}

/** How an activation ended. */
export type ActivationOutcome =
  /** Stopped: woken again by the next message, or by the alarm. */
  | { readonly kind: "idle"; readonly alarm?: number }
  /** Out of time with work left: activated again at once. */
  | { readonly kind: "continue" };

/** What runs an entity once something activates it. */
export type ActivationRun = (
  entity: EntityHandle,
  context: { readonly deadline: number },
) => Promise<ActivationOutcome>;

export interface Activation {
  /** Activates `key` without a message. */
  wake(key: string): Promise<void>;
  /**
   * The consumer of activations, which runs `run` for each, one at a time per key, for at most
   * `budgetMs`. An activation for an entity that doesn't exist does nothing.
   */
  consumer(
    run: ActivationRun,
    options: {
      readonly budgetMs: number;
      readonly observe?: (activation: {
        readonly key: string;
        readonly outcome: ActivationOutcome;
        readonly ms: number;
      }) => void;
    },
  ): ActivationConsumer;
}

export interface ActivationConsumer {
  /** For a World that delivers over HTTP, such as Vercel's. */
  route(): (request: Request) => Promise<Response>;
  /** For a World that delivers in this process, such as the local or Postgres World. */
  serve(): Promise<void>;
  /** One delivery, as the World hands it over. */
  deliver(message: unknown, delivery: { readonly invocationStartedAt?: number }): Promise<unknown>;
}
