import { backedWorld, type BackedRun, type WorldBackend } from "#execution/world/memory-world.js";
import type { RuntimeWorld, WorldEvent } from "#execution/world/runtime-world.js";
import { openDatabase, request, type IdbDatabase } from "./indexed-db.js";

// A World a page keeps in IndexedDB, so its sessions outlive a reload: everything the in-process
// host writes to its World is kept here before it resolves, and a World opened on the same
// database (after a reload, or in another tab) reads it all back. One writer per session.

const RUNS = "runs";
const EVENTS = "events";
const CHUNKS = "chunks";
const CLOSED = "closed";

interface StoredEvent {
  readonly runId: string;
  readonly event: WorldEvent;
  readonly inBand?: boolean;
}

interface StoredChunk {
  readonly stream: string;
  readonly index: number;
  readonly data: Uint8Array;
}

function indexedDbBackend(name: string): WorldBackend {
  let opened: Promise<IdbDatabase> | undefined;
  const objectStore = async <V>(store: string, mode: "readonly" | "readwrite") => {
    opened ??= openDatabase(name, 1, (db) => {
      db.createObjectStore(RUNS, { keyPath: "runId" });
      // Keyed [runId, index] and [stream, index], so each run's events and each stream's chunks
      // read in the order they were written.
      db.createObjectStore(EVENTS);
      db.createObjectStore(CHUNKS);
      db.createObjectStore(CLOSED);
    });
    return (await opened).transaction(store, mode).objectStore<V>(store);
  };
  return {
    async load() {
      const runs = await request((await objectStore<BackedRun>(RUNS, "readonly")).getAll());
      const events = await request((await objectStore<StoredEvent>(EVENTS, "readonly")).getAll());
      const chunks = await request((await objectStore<StoredChunk>(CHUNKS, "readonly")).getAll());
      const closed = await request((await objectStore<string>(CLOSED, "readonly")).getAll());
      return { chunks, closed, events, runs };
    },
    async putRun(run) {
      await request((await objectStore<BackedRun>(RUNS, "readwrite")).put(run));
    },
    async putEvent(runId, index, event, inBand) {
      const store = await objectStore<StoredEvent>(EVENTS, "readwrite");
      await request(store.put({ event, inBand, runId }, [runId, index]));
    },
    async putChunk(stream, index, data) {
      const store = await objectStore<StoredChunk>(CHUNKS, "readwrite");
      await request(store.put({ data, index, stream }, [stream, index]));
    },
    async closeStream(stream) {
      await request((await objectStore<string>(CLOSED, "readwrite")).put(stream, stream));
    },
  };
}

/** A World in the IndexedDB database `name` (`"eve-sessions"` by default), which outlives a reload. */
export function indexedDbWorld(name = "eve-sessions"): RuntimeWorld {
  return backedWorld(indexedDbBackend(name), { deploymentId: "browser" });
}
