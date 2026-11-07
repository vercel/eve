import { RunExpiredError } from "#compiled/@workflow/errors/index.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";

/**
 * Where a session's stream is stored: one encoded line per chunk, as the session's writer wrote
 * them, so a chunk's index is its line's position. Workflow stores a session's stream on the run
 * that started it; another host registers its own store for the sessions it runs.
 */
export interface SessionLineStore {
  /**
   * The stream's chunks from `startIndex`, following writes until the stream closes. A negative
   * `startIndex` counts back from the tail.
   */
  readable(sessionId: string, startIndex?: number): ReadableStream<Uint8Array>;
  /**
   * The position of the last line stored, or `-1` before the first. Throws as
   * {@link assertReadable} does.
   */
  tail(sessionId: string): Promise<number>;
  /** Throws when the session's stream doesn't exist or its history has passed retention. */
  assertReadable(sessionId: string): Promise<void>;
}

/** Each session's stream is the readable of the run that started it. */
export const workflowLineStore: SessionLineStore = {
  readable: (sessionId, startIndex) => getRun(sessionId).getReadable({ startIndex }),
  async tail(sessionId) {
    // The readable is never consumed; cancel it so the unread source does not linger.
    const readable = getRun(sessionId).getReadable();
    try {
      const [, tailIndex] = await Promise.all([
        workflowLineStore.assertReadable(sessionId),
        readable.getTailIndex(),
      ]);
      return tailIndex;
    } finally {
      await readable.cancel().catch(() => {});
    }
  },
  // Cheaper than `tail`, whose lookup on the local world opens every chunk file.
  async assertReadable(sessionId) {
    const world = await getWorld();
    const run = await world.runs.get(sessionId, { resolveData: "none" });
    // Purging can leave chunk records behind; their count does not imply readable data.
    if (run.expiredAt !== undefined && run.expiredAt.getTime() <= Date.now()) {
      throw new RunExpiredError(
        "Session history is no longer available.",
        sessionId,
        run.status,
        run.expiredAt,
      );
    }
  },
};

// Process-wide, so separately bundled copies of this module see the same sessions.
const REGISTERED = Symbol.for("eve.session-line-stores");
type Registry = Map<string, SessionLineStore>;

function registry(): Registry {
  const global = globalThis as { [REGISTERED]?: Registry };
  return (global[REGISTERED] ??= new Map());
}

/**
 * Stores `sessionId`'s stream in `store` instead of on a Workflow run, for every reader in this
 * process. Returns what unregisters it.
 */
export function registerSessionLineStore(sessionId: string, store: SessionLineStore): () => void {
  const sessions = registry();
  if (sessions.has(sessionId)) throw new Error(`Session "${sessionId}" already has a line store.`);
  sessions.set(sessionId, store);
  return () => {
    if (sessions.get(sessionId) === store) sessions.delete(sessionId);
  };
}

/** The store that holds `sessionId`'s stream: a registered one, or Workflow's. */
export function sessionLineStore(sessionId: string): SessionLineStore {
  return registry().get(sessionId) ?? workflowLineStore;
}
