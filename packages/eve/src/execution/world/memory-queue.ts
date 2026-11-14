import { HookNotFoundError, RunNotFoundError } from "#shared/run-errors.js";
import { createUlid } from "#shared/ulid.js";
import type {
  QueueWorld,
  RuntimeWorld,
  WorldQueueDelivery,
  WorldStreamChunk,
} from "./runtime-world.js";

// A World in this process (`memoryWorld()`, say) with what a host that runs sessions only when
// something arrives needs besides (`QueueWorld`): hooks a token names (one run's at a time, as
// Workflow's: a token another live run holds is a `hook_conflict`, and a run's hooks go when it
// ends), runs that end (`run_completed`, after which they take no writes), a live stream read,
// and a queue that delivers in this process. As Workflow's queues do for a spec 9 run, it delivers one
// message naming a run at a time, so one activation runs per actor; a handler's
// `{ timeoutSeconds }` asks for the message again after that long (`0`: at once), and a throw
// retries it. Delays and idempotency keys work as Workflow's do. Nothing survives the process.

/** How long a delivery that threw waits before the queue retries it. */
const RETRY_MS = 1_000;
/** How many times a message that keeps throwing is delivered before the queue drops it. */
const MAX_ATTEMPTS = 5;

type Handler = (message: unknown, delivery: WorldQueueDelivery) => Promise<unknown>;

interface Queued {
  readonly messageId: string;
  readonly queueName: string;
  readonly message: unknown;
  attempt: number;
  deliveries: number;
}

/** What `createQueueHandler` returned, by the handler it wraps: what `registerHandler` serves. */
const HANDLERS = new WeakMap<(request: Request) => Promise<Response>, Handler>();

export interface MemoryQueueWorld extends QueueWorld {
  /** Stops delivering, and drops what's queued. */
  close(): Promise<void>;
  /**
   * Resolves once no message is due or being delivered: what a test waits on before it reads.
   * A message delayed to later (an alarm) isn't waited for.
   */
  idle(): Promise<void>;
}

/** `world`, with hooks, a live stream read, and a queue in this process. */
export function withMemoryQueue(world: RuntimeWorld): MemoryQueueWorld {
  const hooks = new Map<string, { readonly hookId: string; readonly runId: string }>();
  // How each run ended, once it did.
  const ends = new Map<string, string>();
  // Runs whose retention is zero, and when what they kept expired: once they ended.
  const purging = new Set<string>();
  const expired = new Map<string, Date>();
  const streamWaiters = new Map<string, Set<() => void>>();
  const handlers = new Map<string, Handler>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const seenKeys = new Set<string>();
  // Per run: whether a delivery runs now, and what waits behind it, in order.
  const lanes = new Map<string, { running: boolean; readonly waiting: Queued[] }>();
  let pending = 0;
  let started = false;
  let closed = false;
  const idleWaiters = new Set<() => void>();
  const early: Queued[] = [];

  const streamKey = (runId: string, name: string) => `${runId}\u0000${name}`;
  const wakeStream = (runId: string, name: string) => {
    const waiters = streamWaiters.get(streamKey(runId, name));
    if (waiters === undefined) return;
    streamWaiters.delete(streamKey(runId, name));
    for (const wake of waiters) wake();
  };
  const settled = () => {
    if (pending > 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const handlerFor = (queueName: string): Handler | undefined => {
    for (const [prefix, handler] of handlers) if (queueName.startsWith(prefix)) return handler;
    return undefined;
  };
  const laneOf = (message: unknown): string => {
    const runId = (message as { readonly runId?: unknown } | null)?.runId;
    return typeof runId === "string" ? runId : `message:${createUlid()}`;
  };

  /** Delivers `queued` now, or once its run's lane is free. */
  const dispatch = (queued: Queued): void => {
    if (closed) return settledOne();
    if (!started || handlerFor(queued.queueName) === undefined) {
      early.push(queued);
      return;
    }
    const laneKey = laneOf(queued.message);
    let lane = lanes.get(laneKey);
    if (lane === undefined) lanes.set(laneKey, (lane = { running: false, waiting: [] }));
    lane.waiting.push(queued);
    void drain(laneKey);
  };
  const settledOne = () => {
    pending -= 1;
    settled();
  };
  /** Delivers `queued` in `ms`; until then it isn't pending (`idle` doesn't wait for it). */
  const later = (queued: Queued, ms: number): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      pending += 1;
      dispatch(queued);
    }, ms);
    timer.unref?.();
    timers.add(timer);
  };
  const drain = async (laneKey: string): Promise<void> => {
    const lane = lanes.get(laneKey);
    if (lane === undefined || lane.running) return;
    const queued = lane.waiting.shift();
    if (queued === undefined) {
      lanes.delete(laneKey);
      return;
    }
    lane.running = true;
    const handler = handlerFor(queued.queueName)!;
    queued.deliveries += 1;
    try {
      const result = (await handler(structuredClone(queued.message), {
        attempt: queued.attempt,
        deliveryCount: queued.deliveries,
        invocationStartedAt: Date.now(),
        messageId: queued.messageId,
      })) as { readonly timeoutSeconds?: unknown } | undefined;
      const seconds = result?.timeoutSeconds;
      if (typeof seconds === "number") {
        // A handoff isn't a retry.
        if (seconds === 0) {
          lane.waiting.unshift(queued);
        } else {
          settledOne();
          later(queued, seconds * 1000);
        }
      } else settledOne();
    } catch {
      queued.attempt += 1;
      settledOne();
      if (queued.attempt <= MAX_ATTEMPTS) later(queued, RETRY_MS);
    } finally {
      lane.running = false;
      void drain(laneKey);
    }
  };

  return {
    ...world,
    capabilities: world.capabilities,
    getDeploymentId: () => world.getDeploymentId(),
    events: {
      async create(runId, data, params) {
        const type = data.eventType as string;
        if (type === "run_created") {
          const attributes = (data as { readonly eventData?: { readonly attributes?: unknown } })
            .eventData?.attributes as Readonly<Record<string, string>> | undefined;
          if (attributes?.$retention === "0") purging.add(runId);
        }
        if (ends.has(runId) && type !== "run_created")
          throw new Error(`Run "${runId}" is in a terminal state (${ends.get(runId)!}).`);
        if (type === "hook_created") {
          const created = hookCreated(data);
          const { token } = created;
          const holder = hooks.get(token);
          // Workflow's World keeps the token where it is, and says so; nothing is written here.
          if (holder !== undefined && holder.runId !== runId)
            return { event: { eventType: "hook_conflict", token } };
          // Held from now, before the write lands: a token is one run's, as on Workflow's World,
          // however close together two runs ask for it.
          hooks.set(token, { hookId: created.hookId, runId });
          try {
            return { event: await world.events.create(runId, data, params) };
          } catch (error) {
            if (hooks.get(token)?.runId === runId) hooks.delete(token);
            throw error;
          }
        }
        const event = await world.events.create(runId, data, params);
        if (type === "run_completed" || type === "run_failed" || type === "run_cancelled") {
          ends.set(runId, type.slice("run_".length));
          if (purging.has(runId)) expired.set(runId, new Date());
          for (const [token, hook] of hooks) if (hook.runId === runId) hooks.delete(token);
        }
        return { event };
      },
      async list(params) {
        // What a run whose retention is zero kept is gone once it ended.
        if (expired.has(params.runId)) throw new RunNotFoundError(params.runId);
        return await world.events.list(params);
      },
    },
    hooks: {
      async getByToken(token) {
        const hook = hooks.get(token);
        if (hook === undefined) throw new HookNotFoundError(token);
        return { ...hook, token };
      },
    },
    runs: {
      list: (params) => world.runs.list(params),
      async get(runId) {
        let cursor: string | undefined;
        do {
          const page = await world.runs.list({
            pagination: { limit: 1000, ...(cursor !== undefined && { cursor }) },
            resolveData: "none",
          });
          const run = page.data.find((candidate) => candidate.runId === runId);
          if (run !== undefined)
            return {
              ...run,
              status: ends.get(runId) ?? "running",
              ...(expired.has(runId) && { expiredAt: expired.get(runId)! }),
            };
          cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
        } while (cursor !== undefined);
        throw new RunNotFoundError(runId);
      },
    },
    streams: {
      ...world.streams,
      async write(runId, name, chunk) {
        await world.streams.write(runId, name, chunk);
        wakeStream(runId, name);
      },
      async writeMulti(runId, name, chunks) {
        if (world.streams.writeMulti !== undefined)
          await world.streams.writeMulti(runId, name, chunks);
        else for (const chunk of chunks) await world.streams.write(runId, name, chunk);
        wakeStream(runId, name);
      },
      async close(runId, name) {
        await world.streams.close(runId, name);
        wakeStream(runId, name);
      },
      async getChunks(runId, name, options) {
        if (expired.has(runId)) return { cursor: null, data: [], done: true, hasMore: false };
        return await world.streams.getChunks(runId, name, options);
      },
      async getInfo(runId, name) {
        if (expired.has(runId)) return { done: true, tailIndex: -1 };
        return await world.streams.getInfo(runId, name);
      },
      async get(runId, name, startIndex = 0) {
        let next = startIndex;
        let cancelled = false;
        let wake: (() => void) | undefined;
        const buffered: WorldStreamChunk[] = [];
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            while (!cancelled) {
              const ready = buffered.shift();
              if (ready !== undefined) {
                controller.enqueue(ready.data);
                return;
              }
              // Registered before reading, so a write between the read and the wait wakes it.
              const written = new Promise<void>((resolve) => {
                wake = resolve;
                const key = streamKey(runId, name);
                let waiters = streamWaiters.get(key);
                if (waiters === undefined) streamWaiters.set(key, (waiters = new Set()));
                waiters.add(resolve);
              });
              const info = await world.streams.getInfo(runId, name);
              if (info.tailIndex >= next) {
                let cursor: string | undefined;
                do {
                  const page = await world.streams.getChunks(runId, name, {
                    limit: 1000,
                    ...(cursor !== undefined && { cursor }),
                  });
                  for (const chunk of page.data)
                    if (chunk.index >= next) {
                      buffered.push(chunk);
                      next = chunk.index + 1;
                    }
                  cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
                } while (cursor !== undefined);
                continue;
              }
              if (info.done) {
                controller.close();
                return;
              }
              await written;
            }
          },
          cancel() {
            cancelled = true;
            wake?.();
          },
        });
      },
    },
    async queue(queueName, message, options) {
      const key = options?.idempotencyKey;
      if (key !== undefined) {
        if (seenKeys.has(key)) return { messageId: null };
        seenKeys.add(key);
      }
      const queued: Queued = {
        attempt: 1,
        deliveries: 0,
        message: structuredClone(message),
        messageId: `msg_${createUlid()}`,
        queueName,
      };
      const delayMs = (options?.delaySeconds ?? 0) * 1000;
      if (delayMs > 0) later(queued, delayMs);
      else {
        pending += 1;
        dispatch(queued);
      }
      return { messageId: queued.messageId };
    },
    createQueueHandler(_prefix, handler) {
      const route = async (): Promise<Response> => {
        throw new Error("This World's queue delivers in this process; register the handler.");
      };
      HANDLERS.set(route, handler);
      return route;
    },
    registerHandler(prefix, route) {
      const handler = HANDLERS.get(route);
      if (handler === undefined)
        throw new Error("Register a handler this World's `createQueueHandler` made.");
      handlers.set(prefix, handler);
    },
    async start() {
      started = true;
      for (const queued of early.splice(0)) dispatch(queued);
    },
    async close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      pending = 0;
      settled();
    },
    async idle() {
      if (pending === 0) return;
      await new Promise<void>((resolve) => idleWaiters.add(resolve));
    },
  };
}

/** A `hook_created` event's hook: its id (the event's correlation id) and its token. */
function hookCreated(data: unknown): { readonly hookId: string; readonly token: string } {
  const event = data as {
    readonly correlationId?: unknown;
    readonly eventData?: { readonly token?: unknown };
  };
  if (typeof event.correlationId !== "string" || typeof event.eventData?.token !== "string")
    throw new Error("A `hook_created` event names its hook and its token.");
  return { hookId: event.correlationId, token: event.eventData.token };
}
