import { RunNotFoundError } from "#shared/run-errors.js";
import { serialPerKey } from "#shared/serial-per-key.js";
import { createUlid } from "#shared/ulid.js";
import type {
  RuntimeWorld,
  WorldEvent,
  WorldEventRequest,
  WorldPage,
  WorldPagination,
  WorldRun,
} from "./runtime-world.js";

// A World kept in this process's memory: the part of a Workflow World eve's in-process host uses,
// for scripts, tests and anything else that needn't outlive the process. What a runtime writes is
// copied in, and what it reads copied out, as a World outside the process would, so a runtime
// that later stops leaves its sessions here for another runtime in this process to continue.
//
// With a backend (`backedWorld`), the same World also keeps everything somewhere that outlives
// the process, such as a page's IndexedDB: it reads the backend once as it opens, and each write
// is kept there before it resolves.
//
// Internal for now: a first-class in-memory World belongs with Workflow's Worlds, and this one is
// swapped for it once there is one.

/** A World's refusal to create what it already holds, named as Workflow's is. */
class EntityConflictError extends Error {
  override readonly name = "EntityConflictError";
}

/** A World's refusal of an in-band write another writer superseded, named as Workflow's is. */
class InBandSupersededError extends Error {
  override readonly name = "InBandSupersededError";
}

/** The spec version from which a run's in-band writes are fenced. */
const FENCED_SPEC = 9;

/** Where a backed World keeps what it holds. Each write resolves once it's kept. */
export interface WorldBackend {
  /** Everything kept, read once as the World opens. */
  load(): Promise<{
    readonly runs: readonly BackedRun[];
    readonly events: readonly {
      readonly runId: string;
      readonly event: WorldEvent;
      readonly inBand?: boolean;
    }[];
    readonly chunks: readonly {
      readonly stream: string;
      readonly index: number;
      readonly data: Uint8Array;
    }[];
    readonly closed: readonly string[];
  }>;
  putRun(run: BackedRun): Promise<void>;
  putEvent(runId: string, index: number, event: WorldEvent, inBand: boolean): Promise<void>;
  putChunk(stream: string, index: number, data: Uint8Array): Promise<void>;
  closeStream(stream: string): Promise<void>;
}

interface MemoryStream {
  readonly chunks: Uint8Array[];
  done: boolean;
}

/** A run as a backend keeps it: with the spec it was created at, which says if it's fenced. */
export type BackedRun = WorldRun & { readonly specVersion?: number };

interface MemoryRun {
  readonly run: BackedRun;
  readonly events: WorldEvent[];
  started: boolean;
  /** Positions in-band writes took, `run_created` the first. */
  seqInBand: number;
}

const fenced = (held: MemoryRun) => (held.run.specVersion ?? 0) >= FENCED_SPEC;

const DEFAULT_PAGE = 100;

function page<T>(items: readonly T[], pagination: WorldPagination | undefined): WorldPage<T> {
  const ordered = pagination?.sortOrder === "desc" ? [...items].reverse() : items;
  const start = pagination?.cursor === undefined ? 0 : Number(pagination.cursor);
  const end = start + (pagination?.limit ?? DEFAULT_PAGE);
  const hasMore = end < ordered.length;
  return { cursor: hasMore ? String(end) : null, data: ordered.slice(start, end), hasMore };
}

function bytesOf(chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk.slice();
}

const streamKey = (runId: string, name: string) => `${runId}\u0000${name}`;

export interface MemoryWorldOptions {
  readonly deploymentId?: string;
}

/** A World in this process's memory; see the module comment. */
export function memoryWorld(options: MemoryWorldOptions = {}): RuntimeWorld {
  return backedWorld(undefined, options);
}

/** A World in this process's memory that also keeps everything in `backend`, if given. */
export function backedWorld(
  backend: WorldBackend | undefined,
  options: MemoryWorldOptions = {},
): RuntimeWorld {
  const runs = new Map<string, MemoryRun>();
  const streams = new Map<string, MemoryStream>();
  const deploymentId = options.deploymentId ?? "in-process";

  const streamOf = (key: string): MemoryStream => {
    let stream = streams.get(key);
    if (stream === undefined) streams.set(key, (stream = { chunks: [], done: false }));
    return stream;
  };
  const opened: Promise<void> =
    backend === undefined
      ? Promise.resolve()
      : backend.load().then((kept) => {
          for (const run of kept.runs)
            runs.set(run.runId, { events: [], run, seqInBand: 1, started: false });
          for (const { event, inBand, runId } of kept.events) {
            const held = runs.get(runId);
            if (held === undefined) continue;
            held.events.push(event);
            if (inBand === true) held.seqInBand += 1;
            if (event.eventType === "run_started") held.started = true;
          }
          const ordered = [...kept.chunks].sort((a, b) => a.index - b.index);
          for (const { data, stream } of ordered) streamOf(stream).chunks.push(data);
          for (const stream of kept.closed) streamOf(stream).done = true;
        });

  const runOf = (runId: string): MemoryRun => {
    const held = runs.get(runId);
    if (held === undefined) throw new RunNotFoundError(runId);
    return held;
  };
  const append = async (
    runId: string,
    held: MemoryRun,
    data: WorldEventRequest,
    inBand = false,
  ) => {
    const event: WorldEvent = {
      createdAt: new Date(),
      eventId: `evnt_${createUlid()}`,
      eventType: data.eventType,
      ...("correlationId" in data && { correlationId: data.correlationId }),
      ...("eventData" in data && { eventData: structuredClone(data.eventData) }),
    };
    await backend?.putEvent(runId, held.events.length, event, inBand);
    held.events.push(event);
    if (inBand) held.seqInBand += 1;
    return event;
  };

  // A run's writes, one at a time: each checks the run (it exists, the fence's count) and then
  // waits on its backend, so two at once would both pass the check.
  const writes = serialPerKey();

  return {
    capabilities: { inBandFence: true },
    getDeploymentId: async () => deploymentId,
    events: {
      async create(runId, data, params) {
        await opened;
        return await writes.run(runId, async () => {
          if (data.eventType === "run_created") {
            if (runs.has(runId)) throw new EntityConflictError(`Run "${runId}" already exists`);
            const run: BackedRun = {
              createdAt: new Date(),
              runId,
              workflowName: data.eventData.workflowName,
              ...(data.specVersion !== undefined && { specVersion: data.specVersion }),
            };
            await backend?.putRun(run);
            // `run_created` is the run's first in-band position.
            const held: MemoryRun = { events: [], run, seqInBand: 0, started: false };
            runs.set(runId, held);
            return await append(runId, held, data, true);
          }
          const held = runOf(runId);
          // The in-band fence: a write in-band is accepted only at the run's in-band count.
          const inBand = params?.inBand === true && fenced(held);
          if (inBand && params?.expectedSeqInBand !== held.seqInBand)
            throw new InBandSupersededError(
              `In-band write on run ${runId} expected seqInBand ${String(params?.expectedSeqInBand)}, but the run is at ${String(held.seqInBand)}.`,
            );
          if (data.eventType === "run_started") {
            if (held.started) throw new EntityConflictError(`Run "${runId}" already started`);
            held.started = true;
          }
          return await append(runId, held, data, inBand);
        });
      },
      async list({ runId, pagination }) {
        await opened;
        const held = runOf(runId);
        const snapshot = fenced(held)
          ? { seq: held.events.length, seqInBand: held.seqInBand }
          : undefined;
        const { cursor, data, hasMore } = page(held.events, pagination);
        return {
          cursor,
          data: data.map((event) => structuredClone(event)),
          hasMore,
          ...(snapshot !== undefined && { snapshot }),
        };
      },
    },
    runs: {
      async list({ pagination, workflowName }) {
        await opened;
        const held = [...runs.values()]
          .map(({ run }) => run)
          .filter((run) => workflowName === undefined || run.workflowName === workflowName)
          .sort((a, b) => a.runId.localeCompare(b.runId));
        return page(held, pagination);
      },
    },
    streams: {
      async write(runId, name, chunk) {
        await opened;
        const key = streamKey(runId, name);
        const stream = streamOf(key);
        if (stream.done) throw new Error(`Stream "${name}" of run "${runId}" is closed.`);
        const data = bytesOf(chunk);
        await backend?.putChunk(key, stream.chunks.length, data);
        stream.chunks.push(data);
      },
      async writeMulti(runId, name, chunks) {
        for (const chunk of chunks) await this.write(runId, name, chunk);
      },
      async close(runId, name) {
        await opened;
        const key = streamKey(runId, name);
        await backend?.closeStream(key);
        streamOf(key).done = true;
      },
      async getChunks(runId, name, options) {
        await opened;
        const stream = streamOf(streamKey(runId, name));
        const indexed = stream.chunks.map((data, index) => ({ data: data.slice(), index }));
        const { cursor, data, hasMore } = page(indexed, {
          limit: options?.limit ?? 1000,
          ...(options?.cursor !== undefined && { cursor: options.cursor }),
        });
        return { cursor, data, done: stream.done, hasMore };
      },
      async getInfo(runId, name) {
        await opened;
        const stream = streamOf(streamKey(runId, name));
        return { done: stream.done, tailIndex: stream.chunks.length - 1 };
      },
    },
  };
}
