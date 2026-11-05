import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import {
  appendSessionEntry,
  appendSessionLines,
  claimSessionRun,
  ensureSessionRun,
  listSessionRuns,
  readSessionEntriesBackwards,
  readSessionLines,
  sessionLinesStream,
  sessionRunId,
  SessionTakenOverError,
  type SessionWriter,
} from "#execution/world/session-runs.js";
import { serialPerKey } from "#shared/serial-per-key.js";
import {
  withAppendedInputs,
  type AcceptedInput,
  type SessionState,
  type SessionStore,
  type StoredSession,
} from "./session-store.js";
import type { SessionSnapshot } from "./snapshot.js";

// The in-process host's sessions on a World (`session-runs.ts`): each session is one run, whose
// stream holds its lines and whose log holds what it continues from:
//   - `eve.input`: an input, kept before its address accepts it;
//   - `eve.state`: the rest, at a step boundary;
//   - `eve.delta`: the rest at a later step boundary, as a change from the state before it: the
//     history messages it added, and everything else whole (small beside the history). A step
//     that rewrote the history (a compaction), a session's first save in a process, and every
//     `FULL_STATE_EVERY`th save write a whole `eve.state` instead.
// Loading a session reads back to its newest whole state, applies the changes after it, and adds
// the inputs after those.
//
// One process writes a session (`session-runs.ts`): this store creates a session's run, or claims
// a run it finds (a session continued) before its first write. On a fenced run, a batch of
// stream lines is announced first by a fenced `eve.lines` entry, so the lines of a process that
// lost the session never reach its stream. Once the World refuses a write, every later write
// of that session fails here (`SessionTakenOverError`), before it reaches the World.

const STATE_ENTRY = "eve.state";
const INPUT_ENTRY = "eve.input";
const LINES_ENTRY = "eve.lines";
const DELTA_ENTRY = "eve.delta";

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

export interface WorldSessionStoreOptions {
  /** Once, when the World refuses a session's write because another process took it over. */
  readonly onTakenOver?: (sessionId: string, error: SessionTakenOverError) => void;
}

export function createWorldSessionStore(
  world: RuntimeWorld,
  options: WorldSessionStoreOptions = {},
): SessionStore {
  // How this process writes each session it wrote, and how many lines each run's stream holds.
  const writers = new Map<string, SessionWriter>();
  const lineCounts = new Map<string, number>();
  // What this store last saved of each session, which its next save is a change from.
  const saved = new Map<string, Saved>();
  // Sessions another process took over: this one writes them no more.
  const lost = new Map<string, SessionTakenOverError>();
  // A session's writes land in the order they were made.
  const writes = serialPerKey();

  const writerOf = async (sessionId: string): Promise<SessionWriter> => {
    const known = writers.get(sessionId);
    if (known !== undefined) return known;
    const writer =
      (await ensureSessionRun(world, sessionId)) ?? (await claimSessionRun(world, sessionId));
    writers.set(sessionId, writer);
    return writer;
  };
  /** Runs one of `sessionId`'s writes, in order, unless another process took the session over. */
  const write = async (sessionId: string, run: () => Promise<void>): Promise<void> => {
    await writes.run(sessionId, async () => {
      const taken = lost.get(sessionId);
      if (taken !== undefined) throw taken;
      try {
        await run();
      } catch (error) {
        if (error instanceof SessionTakenOverError && !lost.has(sessionId)) {
          lost.set(sessionId, error);
          options.onTakenOver?.(sessionId, error);
        }
        throw error;
      }
    });
  };
  const append = async (sessionId: string, kind: string, value: unknown): Promise<void> => {
    const writer = await writerOf(sessionId);
    await appendSessionEntry(world, sessionId, kind, value, writer);
  };
  /**
   * The session's state as its log holds it: its newest whole state with the changes after it
   * applied, and the inputs appended after that whole state.
   */
  const readLog = async (sessionId: string) => {
    const entries = await readSessionEntriesBackwards(
      world,
      sessionId,
      (entry) => entry.kind === STATE_ENTRY,
    );
    const whole = entries?.find((entry) => entry.kind === STATE_ENTRY)?.value as
      | SessionState
      | undefined;
    if (entries === undefined || whole === undefined) return undefined;
    // Entries read newest first: oldest first from here.
    const later = [...entries].reverse();
    let state = whole;
    for (const entry of later)
      if (entry.kind === DELTA_ENTRY) state = applied(state, entry.value as StateDelta);
    const inputs = later
      .filter((entry) => entry.kind === INPUT_ENTRY)
      .map((entry) => entry.value as AcceptedInput);
    return { inputs, state };
  };

  /** Saves `state` whole, or as a change from what this store saved of it last. */
  const saveOf = async (state: SessionState): Promise<void> => {
    const { sessionId } = state;
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
      await append(sessionId, DELTA_ENTRY, delta);
      saved.set(sessionId, { changes: before.changes + 1, messages });
      return;
    }
    await append(sessionId, STATE_ENTRY, state);
    saved.set(sessionId, { changes: 0, messages });
  };

  return {
    async appendLines(sessionId, position, lines) {
      await write(sessionId, async () => {
        const writer = await writerOf(sessionId);
        const count =
          lineCounts.get(sessionId) ??
          (await world.streams.getInfo(sessionRunId(sessionId), sessionLinesStream(sessionId)))
            .tailIndex + 1;
        if (position !== count)
          throw new Error(
            `Session "${sessionId}" has ${String(count)} lines stored, not ${String(position)}.`,
          );
        // Announced first on a fenced run: if another process took the session, this is refused
        // and the lines never land.
        if (writer.fenced && lines.length > 0)
          await appendSessionEntry(
            world,
            sessionId,
            LINES_ENTRY,
            { count: lines.length, from: position },
            writer,
          );
        const encoder = new TextEncoder();
        await appendSessionLines(
          world,
          sessionId,
          lines.map((line) => encoder.encode(line)),
        );
        lineCounts.set(sessionId, count + lines.length);
      });
    },
    async appendInput(sessionId, input) {
      await write(sessionId, () => append(sessionId, INPUT_ENTRY, input));
    },
    async saveState(state) {
      await write(state.sessionId, () => saveOf(state));
    },
    async load(sessionId): Promise<SessionSnapshot | undefined> {
      await writes.settled(sessionId);
      const log = await readLog(sessionId);
      if (log === undefined) return undefined;
      const decoder = new TextDecoder();
      const lines = (await readSessionLines(world, sessionId)).map((line) => decoder.decode(line));
      lineCounts.set(sessionId, lines.length);
      return withAppendedInputs({ ...log.state, lines }, log.inputs);
    },
    async list() {
      const sessions: StoredSession[] = [];
      for (const { sessionId } of await listSessionRuns(world)) {
        const log = await readLog(sessionId);
        if (log !== undefined)
          sessions.push({
            open: log.state.open !== undefined,
            savedAt: new Date(log.state.takenAt),
            sessionId,
          });
      }
      return sessions.sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime());
    },
  };
}
