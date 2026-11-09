import { RunNotFoundError } from "#shared/run-errors.js";
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
// Internal for now: a first-class in-memory World belongs with Workflow's Worlds, and this one is
// swapped for it once there is one.

/** A World's refusal to create what it already holds, named as Workflow's is. */
class EntityConflictError extends Error {
  override readonly name = "EntityConflictError";
}

interface MemoryStream {
  readonly chunks: Uint8Array[];
  done: boolean;
}

interface MemoryRun {
  readonly run: WorldRun;
  readonly events: WorldEvent[];
  started: boolean;
}

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

/** A World in this process's memory; see the module comment. */
export function memoryWorld(options: { readonly deploymentId?: string } = {}): RuntimeWorld {
  const runs = new Map<string, MemoryRun>();
  const streams = new Map<string, MemoryStream>();
  const deploymentId = options.deploymentId ?? "in-process";

  const runOf = (runId: string): MemoryRun => {
    const held = runs.get(runId);
    if (held === undefined) throw new RunNotFoundError(runId);
    return held;
  };
  const streamOf = (runId: string, name: string): MemoryStream => {
    const key = `${runId}\u0000${name}`;
    let stream = streams.get(key);
    if (stream === undefined) streams.set(key, (stream = { chunks: [], done: false }));
    return stream;
  };
  const append = (held: MemoryRun, data: WorldEventRequest): WorldEvent => {
    const event: WorldEvent = {
      createdAt: new Date(),
      eventId: `evnt_${createUlid()}`,
      eventType: data.eventType,
      ...("correlationId" in data && { correlationId: data.correlationId }),
      ...("eventData" in data && { eventData: structuredClone(data.eventData) }),
    };
    held.events.push(event);
    return event;
  };

  return {
    getDeploymentId: async () => deploymentId,
    events: {
      async create(runId, data) {
        if (data.eventType === "run_created") {
          if (runs.has(runId)) throw new EntityConflictError(`Run "${runId}" already exists`);
          const held: MemoryRun = {
            events: [],
            run: { createdAt: new Date(), runId, workflowName: data.eventData.workflowName },
            started: false,
          };
          runs.set(runId, held);
          return append(held, data);
        }
        const held = runOf(runId);
        if (data.eventType === "run_started") {
          if (held.started) throw new EntityConflictError(`Run "${runId}" already started`);
          held.started = true;
        }
        return append(held, data);
      },
      async list({ runId, pagination }) {
        const { cursor, data, hasMore } = page(runOf(runId).events, pagination);
        return { cursor, data: data.map((event) => structuredClone(event)), hasMore };
      },
    },
    runs: {
      async list({ pagination, workflowName }) {
        const held = [...runs.values()]
          .map(({ run }) => run)
          .filter((run) => workflowName === undefined || run.workflowName === workflowName)
          .sort((a, b) => a.runId.localeCompare(b.runId));
        return page(held, pagination);
      },
    },
    streams: {
      async write(runId, name, chunk) {
        const stream = streamOf(runId, name);
        if (stream.done) throw new Error(`Stream "${name}" of run "${runId}" is closed.`);
        stream.chunks.push(bytesOf(chunk));
      },
      async writeMulti(runId, name, chunks) {
        for (const chunk of chunks) await this.write(runId, name, chunk);
      },
      async close(runId, name) {
        streamOf(runId, name).done = true;
      },
      async getChunks(runId, name, options) {
        const stream = streamOf(runId, name);
        const indexed = stream.chunks.map((data, index) => ({ data: data.slice(), index }));
        const { cursor, data, hasMore } = page(indexed, {
          limit: options?.limit ?? 1000,
          ...(options?.cursor !== undefined && { cursor: options.cursor }),
        });
        return { cursor, data, done: stream.done, hasMore };
      },
      async getInfo(runId, name) {
        const stream = streamOf(runId, name);
        return { done: stream.done, tailIndex: stream.chunks.length - 1 };
      },
    },
  };
}
