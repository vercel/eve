import type { SessionCommand } from "#channel/types.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { lineCount, type SessionSnapshot } from "./snapshot.js";

// Where an in-process host keeps each session while it runs, so that another process continues
// it after this one stops, however it stops. A session's stream lines and the inputs its
// addresses accept are appended as they happen; the rest of what it continues from is replaced
// at every step boundary. Its one implementation keeps sessions on a World (`world-store.ts`),
// so a World's backends (memory, files, a database, a browser's storage) are its backends. It's
// the one port a host keeps sessions through: a snapshot taken whole goes in with
// `saveSnapshot`.

/**
 * One command, or one message from a run, a session's address accepted, kept until a step the
 * session saved has read it.
 */
export type AcceptedInput = {
  /** In the order the session's addresses accepted them, from 0. */
  readonly seq: number;
  /** The address it arrived at. */
  readonly token: string;
} & ({ readonly command: SessionCommand } | { readonly runMessage: WorkflowToolRunMessage });

/** What a session continues from besides its stream: a snapshot without its lines. */
export type SessionState = Omit<SessionSnapshot, "lines" | "linesFrom">;

/** How much of a session's stream a load reads. */
export interface LoadOptions {
  /**
   * `"all"` (the default) reads every line; `"count"` reads none, only how many there are
   * (`linesFrom`), for a host whose readers read the stream from its World.
   */
  readonly lines?: "all" | "count";
}

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
  load(sessionId: string, options?: LoadOptions): Promise<SessionSnapshot | undefined>;
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
  const stored = await store.load(snapshot.sessionId, { lines: "count" });
  const kept = stored === undefined ? 0 : lineCount(stored);
  const from = snapshot.linesFrom ?? 0;
  if (kept > lineCount(snapshot))
    throw new Error(
      `The store holds more of session "${snapshot.sessionId}" than this snapshot; restore what it holds.`,
    );
  if (kept < from)
    throw new Error(
      `Session "${snapshot.sessionId}"'s snapshot starts at line ${String(from)}, and the store holds ${String(kept)}.`,
    );
  if (kept < lineCount(snapshot))
    await store.appendLines(snapshot.sessionId, kept, snapshot.lines.slice(kept - from));
  const { lines: _lines, linesFrom: _linesFrom, ...state } = snapshot;
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
  const heard = heardWith(snapshot.inputs?.heard, later);
  return {
    ...snapshot,
    inputs: {
      next: last.seq + 1,
      unread: [...(snapshot.inputs?.unread ?? []), ...later],
      ...(heard !== undefined && { heard }),
    },
  };
}

/** `heard`, counting the run messages among `inputs` too; `undefined` while no run sent any. */
export function heardWith(
  heard: Readonly<Record<string, number>> | undefined,
  inputs: readonly AcceptedInput[],
): Readonly<Record<string, number>> | undefined {
  let counted = heard;
  for (const input of inputs) {
    if (!("runMessage" in input)) continue;
    const { runId } = input.runMessage.from;
    counted = { ...counted, [runId]: (counted?.[runId] ?? 0) + 1 };
  }
  return counted;
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
      load: async (sessionId, options) => await store.load(sessionId, options),
      saveState: async (state) => {
        if (!stopped) await store.saveState(state);
      },
    },
  };
}
