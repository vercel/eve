import {
  type EntityHandle,
  type JournalRecord,
  TakenOverError,
} from "#execution/entity/entities.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import { sessionEntities } from "#execution/world/session-entities.js";
import { serialPerKey } from "#shared/serial-per-key.js";
import {
  withAppendedInputs,
  type AcceptedInput,
  type SessionState,
  type SessionStore,
  type StoredSession,
} from "./session-store.js";
import type { SessionSnapshot } from "./snapshot.js";

// The in-process host's sessions as entities on a World (`#execution/entity`): a session is an
// entity whose stream holds its lines and whose journal holds what it continues from:
//   - `eve.input`: an input, kept before its address accepts it;
//   - `eve.state`: the rest, at a step boundary, as a snapshot;
//   - `eve.delta`: the rest at a later step boundary, as a change from the state before it: the
//     history messages it added, and everything else whole (small beside the history). A step
//     that rewrote the history (a compaction), a session's first save in a process, and every
//     `FULL_STATE_EVERY`th save write a whole `eve.state` instead.
// Loading a session reads its journal from its newest whole state, applies the changes after it,
// and adds the inputs after those.
//
// One process writes a session: this store opens it (creating it, or fencing out whoever wrote it
// before) at its first write. Once the entity refuses a write, every later write of that session
// fails here (`TakenOverError`), before it reaches the World.

const STATE_RECORD = "eve.state";
const INPUT_RECORD = "eve.input";
const DELTA_RECORD = "eve.delta";

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
  let state = journal.snapshot.value as SessionState;
  for (const record of journal.after)
    if (record.kind === DELTA_RECORD) state = applied(state, record.value as StateDelta);
  const inputs = journal.after
    .filter((record) => record.kind === INPUT_RECORD)
    .map((record) => record.value as AcceptedInput);
  return { inputs, state };
}

export interface WorldSessionStoreOptions {
  /** Once, when the World refuses a session's write because another process took it over. */
  readonly onTakenOver?: (sessionId: string, error: TakenOverError) => void;
}

export function createWorldSessionStore(
  world: RuntimeWorld,
  options: WorldSessionStoreOptions = {},
): SessionStore {
  const entities = sessionEntities(world);
  const opened = new Map<string, Promise<EntityHandle>>();
  // What this store last saved of each session, which its next save is a change from.
  const saved = new Map<string, Saved>();
  // Sessions another process took over: this one writes them no more.
  const lost = new Map<string, TakenOverError>();
  // A session's writes land in the order they were made.
  const writes = serialPerKey();

  const handleOf = async (sessionId: string): Promise<EntityHandle> => {
    let handle = opened.get(sessionId);
    if (handle === undefined) {
      handle = entities.open(sessionId);
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

  /** Saves `state` whole, or as a change from what this store saved of it last. */
  const saveOf = async (state: SessionState): Promise<void> => {
    const { sessionId } = state;
    const handle = await handleOf(sessionId);
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
      await handle.append([{ kind: DELTA_RECORD, value: delta }]);
      saved.set(sessionId, { changes: before.changes + 1, messages });
      return;
    }
    await handle.append([{ kind: STATE_RECORD, value: state }], { snapshot: true });
    saved.set(sessionId, { changes: 0, messages });
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
        await (await handleOf(sessionId)).append([{ kind: INPUT_RECORD, value: input }]);
      });
    },
    async saveState(state) {
      await write(state.sessionId, () => saveOf(state));
    },
    async load(sessionId): Promise<SessionSnapshot | undefined> {
      await writes.settled(sessionId);
      const journal = await entities.load(sessionId);
      const log = journal === undefined ? undefined : stateOf(journal);
      if (log === undefined) return undefined;
      const decoder = new TextDecoder();
      const lines = (await entities.chunks(sessionId)).map((line) => decoder.decode(line));
      return withAppendedInputs({ ...log.state, lines }, log.inputs);
    },
    async list() {
      const sessions: StoredSession[] = [];
      for (const { key } of await entities.list()) {
        const journal = await entities.load(key);
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
