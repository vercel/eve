import {
  AliasTakenError,
  type Activation,
  type ActivationOutcome,
  type Actors,
  type ActorHandle,
  type ActorMessage,
  type ActorSeal,
  UNSEALED,
} from "#execution/actor/actors.js";
import type { QueueWorld, RuntimeWorld } from "#execution/world/runtime-world.js";
import { createLogger, logError } from "#internal/logging.js";
import { isHookNotFound, isRunNotFound } from "#shared/run-errors.js";
import { createUlid } from "#shared/ulid.js";
import {
  appendRecord,
  claimOnce,
  claimRun,
  CONSUMED_RECORD,
  createRun,
  type ActorKind,
  keyOfRun,
  listRuns,
  readJournal,
  readMeta,
  runIdOf,
  STREAM_RECORD,
  streamNameOf,
  write,
  type Writer,
  writtenAs,
} from "./runs.js";
import { liveRead, polledRead } from "./stream-read.js";

// Actors on today's Worlds (`runs.ts` has the run underneath).
//   - The mailbox is the run's hooks: one per alias, and one for the key itself. A message is a
//     `hook_received` the sender writes out of band (a spec 9 run refuses a write that doesn't
//     say), carrying the alias it was sent to and its body. A message's id is where a read
//     resumes: the page cursor it was read from, and its event.
//   - The stream is the run's stream; a write is announced first by a fenced record, so a writer
//     another one took over never writes it.
//   - Activation is a queue message naming the run; the World delivers one of a spec 9 run's
//     messages at a time. A handoff is `{ timeoutSeconds: 0 }`. The alarm is a delayed message
//     carrying its time and the log's newest event when it was armed: one the queue's longest
//     delay brings early, with nothing newer on the log, is armed again without activating.

/**
 * The stream a value `name` of `key` is kept in: each value kept is its next chunk. The name is
 * encoded, as a World's stream names allow only some characters (no `.` on the local World's).
 */
const valueStreamName = (kind: ActorKind, key: string, name: string) =>
  `${streamNameOf(kind, key)}_value_${base64Url(name)}`;

/** `value`'s UTF-8 bytes as base64url, in any realm (a browser has no `Buffer`). */
const base64Url = (value: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const log = createLogger("execution.actor");

const LOG_PAGE = 100;
/** How long the World's queues delay a message at most: Vercel Queues' 23 hours. */
export const MAX_WAKE_DELAY_SECONDS = 23 * 60 * 60;
/** How early an alarm's message may come and still activate: the actor waits out the rest. */
const EARLY_SLACK_MS = 3_000;

/** How often a watched mailbox is read without a hint: a lost hint's longest delay. */
const HINT_FALLBACK_MS = 5_000;
/** How long a hints read the World ended waits before it opens again. */
const HINT_REOPEN_MS = 200;
/** What a hint carries: nothing, since the mailbox holds the message. */
const HINT = new Uint8Array([0x2a]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface WorldActorsOptions extends Omit<ActorKind, "executionContext"> {
  /** The queue namespace its activations travel in, when the World has a queue. */
  readonly queueNamespace?: string;
  /** How bodies are kept at rest; as written without one. */
  readonly seal?: ActorSeal;
}

/** An activation's queue message. */
interface Wake {
  readonly runId: string;
  readonly runSpecVersion: 9;
  /** An alarm's: when it's due, epoch milliseconds. */
  readonly at?: number;
  /** An alarm's: the newest event on the run's log when it was armed. */
  readonly seen?: string;
}

/**
 * Where a mailbox read resumes: a cursor of the run's log, and the message's event to skip
 * through after it. The newest message a read found resumes from where the read ended, so the
 * next read costs what was written since; any other, from the page it was read on.
 */
interface Position {
  readonly c: string | null;
  readonly e: string | null;
}

const isQueueWorld = (world: RuntimeWorld): world is QueueWorld =>
  typeof (world as Partial<QueueWorld>).queue === "function" &&
  typeof (world as Partial<QueueWorld>).createQueueHandler === "function" &&
  world.hooks !== undefined;

/** The token of the hook that reaches `runId` by its key. */
const keyToken = (runId: string) => `actor:${runId}`;

export function worldActors(world: RuntimeWorld, worldOptions: WorldActorsOptions): Actors {
  const { seal = UNSEALED, ...options } = worldOptions;
  const queueNamespace = options.queueNamespace;
  const queuePrefix =
    queueNamespace === undefined ? undefined : `__${queueNamespace}_wkf_workflow_`;
  const wakeQueue = queuePrefix === undefined ? undefined : `${queuePrefix}${options.kind}`;
  const kind: ActorKind = {
    ...options,
    ...(queueNamespace !== undefined && { executionContext: { queueNamespace } }),
  };
  const queued = isQueueWorld(world) && wakeQueue !== undefined ? world : undefined;
  const runId = (key: string) => runIdOf(kind, key);

  const createHook = async (key: string, writer: Writer, token: string) => {
    const result = await write(world, key, runId(key), writer, {
      correlationId: `hook_${createUlid()}`,
      eventData: { token },
      eventType: "hook_created",
    });
    // A World that holds the token for another run keeps it there, and says so.
    if (writtenAs(result) === "hook_conflict") throw new AliasTakenError(token);
  };

  const newestEvent = async (key: string): Promise<string | undefined> =>
    (
      await world.events.list({
        pagination: { limit: 1, sortOrder: "desc" },
        resolveData: "none",
        runId: runId(key),
      })
    ).data[0]?.eventId;

  const wakeAt = async (key: string, at: number, seen: string | undefined) => {
    if (queued === undefined || wakeQueue === undefined) return;
    const message: Wake = {
      at,
      runId: runId(key),
      runSpecVersion: 9,
      ...(seen !== undefined && { seen }),
    };
    const delaySeconds = Math.min(
      MAX_WAKE_DELAY_SECONDS,
      Math.max(0, Math.ceil((at - Date.now()) / 1000)),
    );
    // Keyed by the time and the day it's sent in: the activations that arm the same alarm send it
    // once, and each day's hop of a long wait is sent anew.
    const day = Math.floor(Date.now() / (MAX_WAKE_DELAY_SECONDS * 1000));
    await queued.queue(wakeQueue, message, {
      delaySeconds,
      idempotencyKey: `eve-alarm:${message.runId}:${String(at)}:${String(day)}`,
    });
  };

  /** Whether `key` ended: its run is in a terminal state. */
  const ended = async (key: string): Promise<boolean> => {
    if (world.runs.get === undefined) return false;
    try {
      const { status } = await world.runs.get(runId(key), { resolveData: "none" });
      return status === "completed" || status === "failed" || status === "cancelled";
    } catch (error) {
      if (isRunNotFound(error)) return false;
      throw error;
    }
  };

  const activation: Activation | undefined =
    queued === undefined || queuePrefix === undefined || wakeQueue === undefined
      ? undefined
      : {
          async wake(key) {
            // No key: one could be absorbed by an activation that's already ending.
            await queued.queue(wakeQueue, { runId: runId(key), runSpecVersion: 9 } satisfies Wake);
          },
          consumer(run, consumerOptions) {
            // Each actor whose last activation here left its mailbox empty, with the newest
            // event on its log then: a wake that finds the log as it was has nothing to do.
            // Senders wake the actor for every message, so the wakes an activation already
            // read the messages of would each activate it again, one after another.
            const quiet = new Map<string, string>();
            const deliver = async (
              message: unknown,
              delivery: { readonly invocationStartedAt?: number },
            ): Promise<unknown> => {
              const wake = message as Partial<Wake> | undefined;
              const key = typeof wake?.runId === "string" ? keyOfRun(kind, wake.runId) : undefined;
              if (key === undefined) return undefined;
              // An alarm the queue's longest delay brought early, with nothing new since it was
              // armed: armed again, without activating the actor.
              if (
                typeof wake?.at === "number" &&
                typeof wake.seen === "string" &&
                wake.at - Date.now() > EARLY_SLACK_MS &&
                (await newestEvent(key)) === wake.seen
              ) {
                await wakeAt(key, wake.at, wake.seen);
                return undefined;
              }
              const settled = quiet.get(key);
              quiet.delete(key);
              if (
                wake?.at === undefined &&
                settled !== undefined &&
                (await newestEvent(key)) === settled
              ) {
                quiet.set(key, settled);
                return undefined;
              }
              const meta = await readMeta(world, seal, key, runId(key));
              if (meta === undefined) return undefined;
              // An actor that ended isn't activated: what reached it late is dropped.
              if (await ended(key)) return undefined;
              const startedAt = delivery.invocationStartedAt ?? Date.now();
              const handle = await openHandle(key, meta);
              let outcome: ActivationOutcome;
              try {
                outcome = await run(handle, { deadline: startedAt + consumerOptions.budgetMs });
              } catch (error) {
                // It ended as this activation ran (the session ended in it): nothing to redo.
                if (isEndedRunConflict(error) && (await ended(key))) return undefined;
                logError(log, `activation of "${key}" failed`, error);
                throw error;
              }
              // Armed after the activation's last write, with the newest event: an early hop that
              // finds nothing newer sleeps again.
              if (outcome.kind === "idle") {
                // The newest event first: a message sent after it is newer, so its wake activates.
                const newest = await newestEvent(key).catch((error: unknown) => {
                  // It ended, and the World let go of its log: nothing is left to wake.
                  if (isRunNotFound(error)) return undefined;
                  throw error;
                });
                if (outcome.alarm !== undefined) await wakeAt(key, outcome.alarm, newest);
                if (newest !== undefined && (await handle.inbox()).length === 0)
                  quiet.set(key, newest);
              }
              consumerOptions.observe?.({ key, ms: Date.now() - startedAt, outcome });
              return outcome.kind === "continue" ? { timeoutSeconds: 0 } : undefined;
            };
            const route = () => queued.createQueueHandler(queuePrefix, deliver);
            return {
              deliver,
              route,
              async serve() {
                queued.registerHandler?.(queuePrefix, route());
                await queued.start?.();
              },
            };
          },
        };

  /** A handle on `key`, whose run exists (`meta` read) or is created here. */
  const openHandle = async (
    key: string,
    knownMeta?: unknown,
    createMeta: unknown = {},
  ): Promise<ActorHandle> => {
    const id = runId(key);
    const created =
      knownMeta === undefined ? await createRun(world, kind, seal, key, createMeta) : undefined;
    const writer = created ?? (await claimRun(world, seal, key, id));
    const meta =
      created !== undefined ? createMeta : (knownMeta ?? (await readMeta(world, seal, key, id)));
    // How far the mailbox is consumed: read once, when first needed.
    let consumed: string | undefined | null = created !== undefined ? undefined : null;
    const consumedNow = async (): Promise<string | undefined> => {
      if (consumed === null)
        consumed = (await readJournal(world, seal, key, id, { untilConsumed: true }))?.consumed;
      return consumed;
    };
    let length: number | undefined;
    return {
      key,
      meta,
      async load() {
        // One read: the journal, and how far the mailbox is consumed, which `inbox` reads from.
        const journal = await readJournal(world, seal, key, id, {
          untilConsumed: consumed === null,
        });
        if (consumed === null) consumed = journal?.consumed;
        return { after: journal?.after ?? [], snapshot: journal?.snapshot };
      },
      async append(records, appendOptions = {}) {
        const through = appendOptions.consumedThrough;
        if (records.length === 0) {
          if (through === undefined) return;
          await appendRecord(
            world,
            seal,
            key,
            id,
            writer,
            { kind: CONSUMED_RECORD, value: null },
            {
              c: through,
            },
          );
          consumed = through;
          return;
        }
        // A snapshot records how far the mailbox is consumed (`""`: none), so a load from it knows.
        const known =
          appendOptions.snapshot === true ? (through ?? (await consumedNow()) ?? "") : through;
        for (const [index, record] of records.entries()) {
          const last = index === records.length - 1;
          await appendRecord(world, seal, key, id, writer, record, {
            ...(last && appendOptions.snapshot === true && { s: true }),
            ...(last && known !== undefined && { c: known }),
          });
        }
        if (through !== undefined) consumed = through;
      },
      async inbox() {
        return await readMailbox(key, id, await consumedNow());
      },
      watchInbox: (onArrival) => watchHints(key, onArrival),
      async end() {
        // A run that ended: the World disposes its hooks, and applies its retention.
        await write(world, key, id, writer, { eventData: {}, eventType: "run_completed" });
      },
      async keep(name, value) {
        await world.streams.write(
          id,
          valueStreamName(kind, key, name),
          await seal.seal(key, value),
        );
      },
      stream: {
        async length() {
          length ??= await streamLength(key);
          return length;
        },
        async append(position, chunks) {
          const count = await this.length();
          if (position !== count)
            throw new Error(
              `"${key}"'s stream holds ${String(count)} chunks, not ${String(position)}.`,
            );
          if (chunks.length === 0) return;
          // Announced first on a fenced run: a writer taken over is refused here, and the chunks
          // never land.
          if (writer.fenced)
            await appendRecord(world, seal, key, id, writer, {
              kind: STREAM_RECORD,
              value: { count: chunks.length, from: position },
            });
          const name = streamNameOf(kind, key);
          const sealed = await Promise.all(chunks.map((chunk) => seal.seal(key, chunk)));
          if (sealed.length > 1 && world.streams.writeMulti !== undefined)
            await world.streams.writeMulti(id, name, sealed);
          else for (const chunk of sealed) await world.streams.write(id, name, chunk);
          length = count + chunks.length;
        },
      },
    };
  };

  /** The messages on `id`'s log after the one `position` names, oldest first. */
  const readMailbox = async (
    key: string,
    id: string,
    position: string | undefined,
  ): Promise<readonly ActorMessage[]> => {
    const from = position === undefined ? undefined : (JSON.parse(position) as Position);
    let cursor = from?.c ?? undefined;
    let skipping = from?.e !== undefined && from.e !== null;
    const messages: ActorMessage[] = [];
    // Where the read ended: past the last event of its last page, when the World says.
    let end: string | null = null;
    do {
      const pageStart = cursor ?? null;
      const page = await world.events.list({
        pagination: { limit: LOG_PAGE, sortOrder: "asc", ...(cursor && { cursor }) },
        resolveData: "all",
        runId: id,
      });
      for (const event of page.data) {
        if (skipping) {
          skipping = event.eventId !== from!.e;
          continue;
        }
        const payload = (event.eventData as { readonly payload?: unknown } | undefined)?.payload;
        if (event.eventType !== "hook_received" || !(payload instanceof Uint8Array)) continue;
        const sent = JSON.parse(decoder.decode(await seal.open(key, payload))) as {
          via?: string;
          body: unknown;
        };
        messages.push({
          body: sent.body,
          id: JSON.stringify({ c: pageStart, e: event.eventId } satisfies Position),
          ...(sent.via !== undefined && { via: sent.via }),
        });
      }
      // Only the last page's cursor is past the read's last event; a World may give none there.
      if (!page.hasMore) end = page.cursor ?? null;
      cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
    const newest = messages.at(-1);
    if (newest !== undefined && end !== null)
      messages[messages.length - 1] = {
        ...newest,
        id: JSON.stringify({ c: end, e: null } satisfies Position),
      };
    return messages;
  };

  /** The stream a sender hints on that a message is in `key`'s mailbox. */
  const hintsOf = (key: string) =>
    streamNameOf({ ...kind, streamNamespace: `${kind.streamNamespace}-hints` }, key);

  /**
   * Follows `key`'s hints live from their end, calling `onArrival` for each, and every
   * `HINT_FALLBACK_MS` besides, in case a hint was lost (a sender that died between its message
   * and its hint) or the World can't read live.
   */
  const watchHints = (key: string, onArrival: () => void): (() => void) => {
    if (world.hooks === undefined) return () => {};
    const id = runId(key);
    const name = hintsOf(key);
    let stopped = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const fallback = setInterval(() => {
      if (!stopped) onArrival();
    }, HINT_FALLBACK_MS);
    fallback.unref?.();
    const get = world.streams.get?.bind(world.streams);
    if (get !== undefined)
      void (async () => {
        let next = (await world.streams.getInfo(id, name)).tailIndex + 1;
        while (!stopped) {
          reader = (await get(id, name, next)).getReader();
          for (;;) {
            const read = await reader.read().catch(() => ({ done: true }) as const);
            if (read.done || stopped) break;
            next += 1;
            onArrival();
          }
          // The World ended the read (a connection's limit): open again where it stopped, after
          // a pause, rather than spin.
          if (!stopped) await new Promise((resolve) => setTimeout(resolve, HINT_REOPEN_MS));
        }
      })().catch((error: unknown) => logError(log, `watching "${key}"'s mailbox failed`, error));
    return () => {
      stopped = true;
      clearInterval(fallback);
      void reader?.cancel().catch(() => {});
    };
  };

  const streamLength = async (key: string): Promise<number> =>
    (await world.streams.getInfo(runId(key), streamNameOf(kind, key))).tailIndex + 1;

  // Whether each run a hook belongs to is an actor of this kind. A World shares its hooks with
  // whatever else runs on it, Workflow's own runs among them, whose ids look like an actor's.
  // A run's kind never changes, so each answer holds.
  const ofKind = new Map<string, Promise<boolean>>();
  const isOfKind = (hookRunId: string): Promise<boolean> => {
    const getRun = world.runs.get;
    if (getRun === undefined) return Promise.resolve(true);
    let known = ofKind.get(hookRunId);
    if (known === undefined) {
      known = getRun(hookRunId, { resolveData: "none" }).then(
        (run) => run.workflowName === kind.workflowName,
        (error: unknown) => {
          if (isRunNotFound(error)) return false;
          throw error;
        },
      );
      ofKind.set(hookRunId, known);
      known.catch(() => ofKind.delete(hookRunId));
    }
    return known;
  };

  /** The hook at `token`, if an actor of this kind holds it. */
  const hookOf = async (token: string) => {
    if (world.hooks === undefined) throw new Error("This World has no hooks to send through.");
    let hook;
    try {
      hook = await world.hooks.getByToken(token);
    } catch (error) {
      if (isHookNotFound(error)) return undefined;
      throw error;
    }
    return keyOfRun(kind, hook.runId) !== undefined && (await isOfKind(hook.runId))
      ? hook
      : undefined;
  };

  return {
    newKey: () => `${kind.kind}_${createUlid()}`,
    async create(key, createOptions) {
      const writer = await createRun(world, kind, seal, key, createOptions.meta, {
        ...(createOptions.purgeOnEnd === true && { purgeOnEnd: true }),
      });
      if (writer === undefined) throw new Error(`The World holds "${key}" already.`);
      const tokens = new Set([keyToken(runId(key)), ...(createOptions.aliases ?? [])]);
      for (const token of tokens) await createHook(key, writer, token);
    },
    meta: async (key) => await readMeta(world, seal, key, runId(key)),
    async info(key) {
      if (world.runs.get === undefined) return undefined;
      try {
        const run = await world.runs.get(runId(key), { resolveData: "none" });
        return {
          status: run.status ?? "running",
          createdAt: new Date(run.createdAt),
          ...(run.expiredAt !== undefined && { expiredAt: new Date(run.expiredAt) }),
        };
      } catch (error) {
        if (isRunNotFound(error)) return undefined;
        throw error;
      }
    },
    async lookup(alias) {
      const hook = await hookOf(alias);
      return hook === undefined ? undefined : keyOfRun(kind, hook.runId);
    },
    async send(to, body) {
      const hook = await hookOf("alias" in to ? to.alias : keyToken(runId(to.key)));
      const key = hook === undefined ? undefined : keyOfRun(kind, hook.runId);
      if (hook === undefined || key === undefined) return undefined;
      const sent = { body, ...("alias" in to && { via: to.alias }) };
      // Written from outside the actor's run: out of band, so the World doesn't count it
      // against the fence of the writer running it.
      await world.events.create(
        hook.runId,
        {
          correlationId: hook.hookId,
          // Sealed under the actor it reaches, as everything it holds is.
          eventData: { payload: await seal.seal(key, encoder.encode(JSON.stringify(sent))) },
          eventType: "hook_received",
          specVersion: 9,
        },
        { inBand: false },
      );
      // A hint for an activation that's running, which reads its mailbox on it; best effort,
      // since the queue's wake and the activation's slow fallback deliver the message anyway.
      await world.streams.write(hook.runId, hintsOf(key), HINT).catch(() => {});
      await activation?.wake(key);
      return { key };
    },
    open: async (key, openOptions) =>
      await openHandle(key, await readMeta(world, seal, key, runId(key)), openOptions?.meta ?? {}),
    async load(key) {
      const journal = await readJournal(world, seal, key, runId(key));
      return journal === undefined
        ? undefined
        : { after: journal.after, snapshot: journal.snapshot };
    },
    streamLength,
    async value(key, name) {
      const id = runId(key);
      const stream = valueStreamName(kind, key, name);
      try {
        const { tailIndex } = await world.streams.getInfo(id, stream);
        if (tailIndex < 0) return undefined;
        let last: Uint8Array | undefined;
        let cursor: string | undefined;
        do {
          const page = await world.streams.getChunks(id, stream, {
            limit: 1000,
            ...(cursor && { cursor }),
          });
          for (const chunk of page.data) last = chunk.data;
          cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
        } while (cursor !== undefined);
        return last === undefined ? undefined : await seal.open(key, last);
      } catch {
        // A World that holds no such stream says so by refusing it.
        return undefined;
      }
    },
    async chunks(key) {
      const id = runId(key);
      const name = streamNameOf(kind, key);
      const chunks: Uint8Array[] = [];
      let cursor: string | undefined;
      do {
        const page = await world.streams.getChunks(id, name, {
          limit: 1000,
          ...(cursor && { cursor }),
        });
        for (const chunk of page.data) chunks.push(await seal.open(key, chunk.data));
        cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
      } while (cursor !== undefined);
      return chunks;
    },
    read(key, from = 0) {
      const id = runId(key);
      const name = streamNameOf(kind, key);
      const tail = async () => (await streamLength(key)) - 1;
      const read =
        world.streams.get === undefined
          ? polledRead(world, id, name, from, tail)
          : liveRead(world, id, name, from, tail, world.streams.get.bind(world.streams));
      return seal === UNSEALED
        ? read
        : read.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform: async (chunk, controller) =>
                controller.enqueue(await seal.open(key, chunk)),
            }),
          );
    },
    list: async () => await listRuns(world, kind),
    async purged(key) {
      if (world.runs.get === undefined) return false;
      let run;
      try {
        run = await world.runs.get(runId(key), { resolveData: "none" });
      } catch (error) {
        if (isRunNotFound(error)) return false;
        throw error;
      }
      return run.expiredAt !== undefined && new Date(run.expiredAt).getTime() <= Date.now();
    },
    once: async (name, occurrence) => await claimOnce(world, name, occurrence),
    ...(activation !== undefined && { activation }),
  };
}

/** A World refusing a write to a run that ended. */
function isEndedRunConflict(error: unknown): boolean {
  return error instanceof Error && /terminal state/u.test(error.message);
}
