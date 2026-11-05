import type { SessionCommand } from "#channel/types.js";
import type { SessionSnapshot } from "./snapshot.js";

// Where an in-process host keeps each session while it runs, so that another process continues
// it after this one stops, however it stops. A session's stream lines and the inputs its
// addresses accept are appended as they happen; the rest of what it continues from is replaced
// at every step boundary. Its one implementation keeps sessions on a World (`world-store.ts`),
// so a World's backends (memory, files, a database, a browser's storage) are its backends. It's
// the one port a host keeps sessions through: a snapshot taken whole goes in with
// `saveSnapshot`.

/** One command a session's address accepted, kept until a step the session saved has read it. */
export interface AcceptedInput {
  /** In the order the session's addresses accepted them, from 0. */
  readonly seq: number;
  /** The address it arrived at. */
  readonly token: string;
  readonly command: SessionCommand;
}

/** What a session continues from besides its stream: a snapshot without its lines. */
export type SessionState = Omit<SessionSnapshot, "lines">;

export interface SessionStore {
  /**
   * Keeps lines the session's stream wrote, the first at `position`. A line counts as written
   * once this resolves, so a restored session's stream holds every line a reader saw.
   */
  appendLines(sessionId: string, position: number, lines: readonly string[]): Promise<void>;
  /** Keeps an input before its address accepts it. */
  appendInput(sessionId: string, input: AcceptedInput): Promise<void>;
  /**
   * Replaces the rest, at a step boundary. Inputs from `state.inputs.next` on, appended after
   * it, are the session's still.
   */
  saveState(state: SessionState): Promise<void>;
  /** The session as stored, with every input it hasn't read; `undefined` when none is stored. */
  load(sessionId: string): Promise<SessionSnapshot | undefined>;
  /** The sessions stored, most recently saved first. */
  list(): Promise<readonly StoredSession[]>;
}

/** One session a store holds. */
export interface StoredSession {
  readonly sessionId: string;
  readonly savedAt: Date;
  /** A turn was open at its last save, which a restore continues. */
  readonly open: boolean;
}

/**
 * Keeps a whole snapshot in `store`, as the session would have kept it as it ran: the lines the
 * store lacks, then the rest. A store that holds more of the session's stream than the snapshot
 * refuses it, since it holds a later session than this one.
 */
export async function saveSnapshot(store: SessionStore, snapshot: SessionSnapshot): Promise<void> {
  const kept = (await store.load(snapshot.sessionId))?.lines.length ?? 0;
  if (kept > snapshot.lines.length)
    throw new Error(
      `The store holds more of session "${snapshot.sessionId}" than this snapshot; restore what it holds.`,
    );
  if (kept < snapshot.lines.length)
    await store.appendLines(snapshot.sessionId, kept, snapshot.lines.slice(kept));
  const { lines: _lines, ...state } = snapshot;
  await store.saveState(state);
}

/** The inputs a stored session holds: those its state names unread, then those appended since. */
export function withAppendedInputs(
  snapshot: SessionSnapshot,
  appended: readonly AcceptedInput[],
): SessionSnapshot {
  const next = snapshot.inputs?.next ?? 0;
  const later = appended.filter((input) => input.seq >= next);
  const last = later.at(-1);
  if (last === undefined) return snapshot;
  return {
    ...snapshot,
    inputs: { next: last.seq + 1, unread: [...(snapshot.inputs?.unread ?? []), ...later] },
  };
}

/**
 * `store` until `stop()`: what sessions write after it, such as the end a runtime's `dispose`
 * gives each, isn't kept, so the store holds them as they were and another process continues
 * them.
 */
export function stoppableStore(store: SessionStore): {
  readonly store: SessionStore;
  stop(): void;
} {
  let stopped = false;
  return {
    stop: () => {
      stopped = true;
    },
    store: {
      appendInput: async (sessionId, input) => {
        if (!stopped) await store.appendInput(sessionId, input);
      },
      appendLines: async (sessionId, position, lines) => {
        if (!stopped) await store.appendLines(sessionId, position, lines);
      },
      list: async () => await store.list(),
      load: async (sessionId) => await store.load(sessionId),
      saveState: async (state) => {
        if (!stopped) await store.saveState(state);
      },
    },
  };
}
