import {
  type Actors,
  type ActorHandle,
  type JournalRecord,
  TakenOverError,
} from "#execution/actor/actors.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import { sessionActors } from "#execution/world/session-actors.js";
import { serialPerKey } from "#shared/serial-per-key.js";
import {
  withAppendedInputs,
  type AcceptedInput,
  type SessionState,
  type SessionStore,
  type StoredSession,
} from "./session-store.js";
import type { SessionSnapshot } from "./snapshot.js";

// The in-process host's sessions as actors on a World (`#execution/actor`): a session is an
// actor whose stream holds its lines and whose journal holds what it continues from:
//   - `eve.input`: an input, kept before its address accepts it;
//   - `eve.state`: the rest, at a step boundary, as a snapshot;
//   - `eve.delta`: the rest at a later step boundary, as a change from the state before it: the
//     history messages it added, and everything else whole (small beside the history). A step
//     that rewrote the history (a compaction), a session's first save in a process, and every
//     `FULL_STATE_EVERY`th save write a whole `eve.state` instead.
// Loading a session reads its journal from its newest whole state, applies the changes after it,
// and adds the inputs after those. Each record's value carries the version it was written at
// (`SESSION_RECORD_VERSION`), and a load migrates an older one forward.
//
// One process writes a session: this store opens it (creating it, or fencing out whoever wrote it
// before) at its first write, or writes through the handle an activation opened (`handles`).
// Once the actor refuses a write, every later write of that session fails here
// (`TakenOverError`), before it reaches the World.
//
// An input taken from the session's mailbox (a World host's arrivals) consumes its message in the
// same write (`receive`), so a crash either keeps both or neither. A message the session takes
// without keeping it as an input (a sign-in callback, which only its memory holds) is consumed by
// the next save of its state instead, or by `flush` when the session stops; until then, later
// inputs don't consume past it.

const STATE_RECORD = "eve.state";
const INPUT_RECORD = "eve.input";
const DELTA_RECORD = "eve.delta";

/**
 * The version of the records this build writes in a session's journal: each record's value is
 * `{ v, b }`, its body under the version it was written at. A session always resumes on the
 * latest code, so this is the contract between what an older build saved and what this one
 * reads: a load migrates an older body forward, one version at a time (`RECORD_MIGRATIONS`), and
 * refuses a newer one, which only a newer build can read. A change to what a record holds bumps
 * the version and adds the migration from the one before.
 */
export const SESSION_RECORD_VERSION = 1;

/**
 * How a record's body at version `n` becomes its body at `n + 1`, by `n`. Version 0 is a body
 * written bare, before records carried a version: it's version 1's as it is.
 */
const RECORD_MIGRATIONS: Readonly<Record<number, (kind: string, body: unknown) => unknown>> = {
  0: (_kind, body) => body,
};

/** A record's value as this build writes it. */
function versioned(body: unknown): { readonly v: number; readonly b: unknown } {
  return { b: body, v: SESSION_RECORD_VERSION };
}

/** Thrown for a record a newer build wrote, which this one can't read. */
export class SessionRecordVersionError extends Error {
  override readonly name = "SessionRecordVersionError";
  constructor(kind: string, version: number) {
    super(
      `A session's "${kind}" record was saved at version ${String(version)}, and this build reads up to ${String(SESSION_RECORD_VERSION)}: continue the session with a newer eve.`,
    );
  }
}

/** `record`'s body, migrated to this build's version. */
export function recordBody(record: JournalRecord): unknown {
  const value = record.value as { readonly v?: unknown; readonly b?: unknown } | null;
  const wrapped =
    value !== null && typeof value === "object" && typeof value.v === "number" && "b" in value;
  let version = wrapped ? (value.v as number) : 0;
  let body = wrapped ? value.b : record.value;
  if (version > SESSION_RECORD_VERSION) throw new SessionRecordVersionError(record.kind, version);
  for (; version < SESSION_RECORD_VERSION; version += 1) {
    const migrate = RECORD_MIGRATIONS[version];
    if (migrate === undefined)
      throw new Error(`No migration of a "${record.kind}" record from version ${String(version)}.`);
    body = migrate(record.kind, body);
  }
  return body;
}

/** How many saves in a row may be changes before a save writes the whole state again. */
const FULL_STATE_EVERY = 25;

type HistoryMessage = SessionState["checkpoint"]["history"][number];

/** A state as a change from the one saved before it. */
interface StateDelta {
  /** How many history messages the state before it had: the change appends after them. */
  readonly from: number;
  readonly append: readonly HistoryMessage[];
  /** The rest of the state, its history left out. */
  readonly state: SessionState;
}

/** What this store last saved of a session, which its next save is a change from. */
interface Saved {
  /** Each history message as saved, serialized, to compare the next state's history with. */
  readonly messages: readonly string[];
  readonly changes: number;
}

function withoutHistory(state: SessionState): SessionState {
  return { ...state, checkpoint: { ...state.checkpoint, history: [] } };
}

/** `state` with `delta` applied: its history appended, and the rest replaced. */
function applied(state: SessionState, delta: StateDelta): SessionState {
  const history = [...state.checkpoint.history.slice(0, delta.from), ...delta.append];
  return { ...delta.state, checkpoint: { ...delta.state.checkpoint, history } };
}

/** The state a journal holds, and the inputs appended after it. */
function stateOf(journal: {
  readonly snapshot: JournalRecord | undefined;
  readonly after: readonly JournalRecord[];
}) {
  if (journal.snapshot?.kind !== STATE_RECORD) return undefined;
  let state = recordBody(journal.snapshot) as SessionState;
  for (const record of journal.after)
    if (record.kind === DELTA_RECORD) state = applied(state, recordBody(record) as StateDelta);
  const inputs = journal.after
    .filter((record) => record.kind === INPUT_RECORD)
    .map((record) => recordBody(record) as AcceptedInput);
  return { inputs, state };
}

export interface WorldSessionStoreOptions {
  /** Once, when the World refuses a session's write because another process took it over. */
  readonly onTakenOver?: (sessionId: string, error: TakenOverError) => void;
  /** The sessions as actors; `sessionActors(world)` by default. */
  readonly actors?: Actors;
  /** A handle this process holds already, such as an activation's: written through, not reopened. */
  readonly handles?: (sessionId: string) => ActorHandle | undefined;
  /**
   * The session whose activation this store writes for (`handles` holds its actor): the others
   * it writes are sessions that one runs (subagents'), created naming it (`ChildMeta`).
   */
  readonly root?: string;
}

export interface WorldSessionStore extends SessionStore {
  /**
   * The next input `sessionId` keeps comes from its mailbox's `messageId`: keeping it consumes
   * the message in the same write.
   */
  receive(sessionId: string, messageId: string): void;
  /**
   * The message `receive` named was handed over. If no input kept it, it's consumed by the next
   * save of the session's state, or by `flush`.
   */
  received(sessionId: string): void;
  /** Consumes what `received` left for a save, now: the session stopped. */
  /** Keeps `value` under `name` for `sessionId`, beside its state (`ActorHandle.keep`). */
  keep(sessionId: string, name: string, value: unknown): Promise<void>;
  flush(sessionId: string): Promise<void>;
}

const valueEncoder = new TextEncoder();

/** What a session's actor is created with when another session's activation runs it. */
export interface ChildMeta {
  readonly root: string;
}

/** The session whose activation runs the one created with `meta`, if another does. */
export function rootOfChild(meta: unknown): string | undefined {
  const root = (meta as Partial<ChildMeta> | undefined)?.root;
  return typeof root === "string" ? root : undefined;
}

export function createWorldSessionStore(
  world: RuntimeWorld,
  options: WorldSessionStoreOptions = {},
): WorldSessionStore {
  const actors = options.actors ?? sessionActors(world);
  const opened = new Map<string, Promise<ActorHandle>>();
  // What this store last saved of each session, which its next save is a change from.
  const saved = new Map<string, Saved>();
  // Sessions another process took over: this one writes them no more.
  const lost = new Map<string, TakenOverError>();
  // The message each session's next kept input consumes.
  const receiving = new Map<string, string>();
  // The newest message each session took without keeping it, which its next save consumes.
  const unsaved = new Map<string, string>();
  // A session's writes land in the order they were made.
  const writes = serialPerKey();

  const handleOf = async (sessionId: string): Promise<ActorHandle> => {
    const held = options.handles?.(sessionId);
    if (held !== undefined) return held;
    let handle = opened.get(sessionId);
    if (handle === undefined) {
      // A session of another one's activation (a subagent's) names it: what arrives for it once
      // the activation stopped goes there.
      handle = actors.open(
        sessionId,
        options.root === undefined
          ? undefined
          : { meta: { root: options.root } satisfies ChildMeta },
      );
      opened.set(sessionId, handle);
      handle.catch(() => opened.delete(sessionId));
    }
    return await handle;
  };
  /** Runs one of `sessionId`'s writes, in order, unless another process took the session over. */
  const write = async (sessionId: string, run: () => Promise<void>): Promise<void> => {
    await writes.run(sessionId, async () => {
      const taken = lost.get(sessionId);
      if (taken !== undefined) throw taken;
      try {
        await run();
      } catch (error) {
        if (error instanceof TakenOverError && !lost.has(sessionId)) {
          lost.set(sessionId, error);
          options.onTakenOver?.(sessionId, error);
        }
        throw error;
      }
    });
  };

  /** Forgets what a write consumed, unless the session took something newer meanwhile. */
  const consumed = (sessionId: string, through: string | undefined) => {
    if (through !== undefined && unsaved.get(sessionId) === through) unsaved.delete(sessionId);
  };

  /** Saves `state` whole, or as a change from what this store saved of it last. */
  const saveOf = async (state: SessionState): Promise<void> => {
    const { sessionId } = state;
    const handle = await handleOf(sessionId);
    // What the session took without keeping it: this save keeps it, so consumes it.
    const through = unsaved.get(sessionId);
    const consumes = through === undefined ? {} : { consumedThrough: through };
    const messages = state.checkpoint.history.map((message) => JSON.stringify(message));
    const before = saved.get(sessionId);
    const grew =
      before !== undefined &&
      before.changes < FULL_STATE_EVERY &&
      messages.length >= before.messages.length &&
      before.messages.every((message, index) => message === messages[index]);
    if (grew) {
      const delta: StateDelta = {
        append: state.checkpoint.history.slice(before.messages.length),
        from: before.messages.length,
        state: withoutHistory(state),
      };
      await handle.append([{ kind: DELTA_RECORD, value: versioned(delta) }], consumes);
      consumed(sessionId, through);
      saved.set(sessionId, { changes: before.changes + 1, messages });
      return;
    }
    await handle.append([{ kind: STATE_RECORD, value: versioned(state) }], {
      snapshot: true,
      ...consumes,
    });
    consumed(sessionId, through);
    saved.set(sessionId, { changes: 0, messages });
  };

  const journalOf = async (sessionId: string) => {
    const held = options.handles?.(sessionId);
    return held !== undefined ? await held.load() : await actors.load(sessionId);
  };

  return {
    async appendLines(sessionId, position, lines) {
      await write(sessionId, async () => {
        const encoder = new TextEncoder();
        await (
          await handleOf(sessionId)
        ).stream.append(
          position,
          lines.map((line) => encoder.encode(line)),
        );
      });
    },
    async appendInput(sessionId, input) {
      await write(sessionId, async () => {
        const message = receiving.get(sessionId);
        receiving.delete(sessionId);
        // Behind a message only memory holds, the input is kept but consumes nothing: the save
        // that keeps the earlier one consumes both. (A crash in between delivers it again; its
        // delivery id drops the repeat.)
        const behind = unsaved.has(sessionId);
        if (message !== undefined && behind) unsaved.set(sessionId, message);
        await (
          await handleOf(sessionId)
        ).append(
          [{ kind: INPUT_RECORD, value: versioned(input) }],
          message === undefined || behind ? {} : { consumedThrough: message },
        );
      });
    },
    async saveState(state) {
      await write(state.sessionId, () => saveOf(state));
    },
    receive(sessionId, messageId) {
      receiving.set(sessionId, messageId);
    },
    received(sessionId) {
      const message = receiving.get(sessionId);
      receiving.delete(sessionId);
      if (message !== undefined) unsaved.set(sessionId, message);
    },
    async keep(sessionId, name, value) {
      await (await handleOf(sessionId)).keep(name, valueEncoder.encode(JSON.stringify(value)));
    },
    async flush(sessionId) {
      await write(sessionId, async () => {
        const through = unsaved.get(sessionId);
        if (through === undefined) return;
        await (await handleOf(sessionId)).append([], { consumedThrough: through });
        consumed(sessionId, through);
      });
    },
    async load(sessionId, loadOptions = {}): Promise<SessionSnapshot | undefined> {
      await writes.settled(sessionId);
      const journal = await journalOf(sessionId);
      const log = journal === undefined ? undefined : stateOf(journal);
      if (log === undefined) return undefined;
      if (loadOptions.lines === "count")
        return withAppendedInputs(
          { ...log.state, lines: [], linesFrom: await actors.streamLength(sessionId) },
          log.inputs,
        );
      const decoder = new TextDecoder();
      const lines = (await actors.chunks(sessionId)).map((line) => decoder.decode(line));
      return withAppendedInputs({ ...log.state, lines }, log.inputs);
    },
    async list() {
      const sessions: StoredSession[] = [];
      for (const { key } of await actors.list()) {
        const journal = await actors.load(key);
        const log = journal === undefined ? undefined : stateOf(journal);
        if (log !== undefined)
          sessions.push({
            open: log.state.open !== undefined,
            savedAt: new Date(log.state.takenAt),
            sessionId: key,
          });
      }
      return sessions.sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime());
    },
  };
}
