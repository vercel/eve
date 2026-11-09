import {
  AliasTakenError,
  type Activation,
  type ActivationOutcome,
  type Entities,
  type EntityHandle,
  type EntityMessage,
} from "#execution/entity/entities.js";
import type { QueueWorld, RuntimeWorld } from "#execution/world/runtime-world.js";
import { createLogger, logError } from "#internal/logging.js";
import { isHookNotFound } from "#shared/run-errors.js";
import { createUlid } from "#shared/ulid.js";
import {
  appendRecord,
  claimOnce,
  claimRun,
  CONSUMED_RECORD,
  createRun,
  type EntityKind,
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

// Entities on today's Worlds (`runs.ts` has the run underneath).
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

const log = createLogger("execution.entity");

const LOG_PAGE = 100;
/** How long the World's queues delay a message at most: Vercel Queues' 23 hours. */
export const MAX_WAKE_DELAY_SECONDS = 23 * 60 * 60;
/** How early an alarm's message may come and still activate: the entity waits out the rest. */
const EARLY_SLACK_MS = 3_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface WorldEntitiesOptions extends Omit<EntityKind, "executionContext"> {
  /** The queue namespace its activations travel in, when the World has a queue. */
  readonly queueNamespace?: string;
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
const keyToken = (runId: string) => `entity:${runId}`;

export function worldEntities(world: RuntimeWorld, options: WorldEntitiesOptions): Entities {
  const queueNamespace = options.queueNamespace;
  const queuePrefix =
    queueNamespace === undefined ? undefined : `__${queueNamespace}_wkf_workflow_`;
  const wakeQueue = queuePrefix === undefined ? undefined : `${queuePrefix}${options.kind}`;
  const kind: EntityKind = {
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

  const activation: Activation | undefined =
    queued === undefined || queuePrefix === undefined || wakeQueue === undefined
      ? undefined
      : {
          async wake(key) {
            // No key: one could be absorbed by an activation that's already ending.
            await queued.queue(wakeQueue, { runId: runId(key), runSpecVersion: 9 } satisfies Wake);
          },
          consumer(run, consumerOptions) {
            const deliver = async (
              message: unknown,
              delivery: { readonly invocationStartedAt?: number },
            ): Promise<unknown> => {
              const wake = message as Partial<Wake> | undefined;
              const key = typeof wake?.runId === "string" ? keyOfRun(kind, wake.runId) : undefined;
              if (key === undefined) return undefined;
              // An alarm the queue's longest delay brought early, with nothing new since it was
              // armed: armed again, without activating the entity.
              if (
                typeof wake?.at === "number" &&
                typeof wake.seen === "string" &&
                wake.at - Date.now() > EARLY_SLACK_MS &&
                (await newestEvent(key)) === wake.seen
              ) {
                await wakeAt(key, wake.at, wake.seen);
                return undefined;
              }
              const meta = await readMeta(world, runId(key));
              if (meta === undefined) return undefined;
              const startedAt = delivery.invocationStartedAt ?? Date.now();
              const handle = await openHandle(key, meta);
              let outcome: ActivationOutcome;
              try {
                outcome = await run(handle, { deadline: startedAt + consumerOptions.budgetMs });
              } catch (error) {
                logError(log, `activation of "${key}" failed`, error);
                throw error;
              }
              // Armed after the activation's last write, with the newest event: an early hop that
              // finds nothing newer sleeps again.
              if (outcome.kind === "idle" && outcome.alarm !== undefined)
                await wakeAt(key, outcome.alarm, await newestEvent(key));
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
  const openHandle = async (key: string, knownMeta?: unknown): Promise<EntityHandle> => {
    const id = runId(key);
    const created = knownMeta === undefined ? await createRun(world, kind, key, {}) : undefined;
    const writer = created ?? (await claimRun(world, key, id));
    const meta = created !== undefined ? {} : (knownMeta ?? (await readMeta(world, id)));
    // How far the mailbox is consumed: read once, when first needed.
    let consumed: string | undefined | null = created !== undefined ? undefined : null;
    const consumedNow = async (): Promise<string | undefined> => {
      if (consumed === null)
        consumed = (await readJournal(world, id, { untilConsumed: true }))?.consumed;
      return consumed;
    };
    let length: number | undefined;
    return {
      key,
      meta,
      async load() {
        // One read: the journal, and how far the mailbox is consumed, which `inbox` reads from.
        const journal = await readJournal(world, id, { untilConsumed: consumed === null });
        if (consumed === null) consumed = journal?.consumed;
        return { after: journal?.after ?? [], snapshot: journal?.snapshot };
      },
      async append(records, appendOptions = {}) {
        const through = appendOptions.consumedThrough;
        if (records.length === 0) {
          if (through === undefined) return;
          await appendRecord(
            world,
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
          await appendRecord(world, key, id, writer, record, {
            ...(last && appendOptions.snapshot === true && { s: true }),
            ...(last && known !== undefined && { c: known }),
          });
        }
        if (through !== undefined) consumed = through;
      },
      async inbox() {
        return await readMailbox(id, await consumedNow());
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
            await appendRecord(world, key, id, writer, {
              kind: STREAM_RECORD,
              value: { count: chunks.length, from: position },
            });
          const name = streamNameOf(kind, key);
          if (chunks.length > 1 && world.streams.writeMulti !== undefined)
            await world.streams.writeMulti(id, name, [...chunks]);
          else for (const chunk of chunks) await world.streams.write(id, name, chunk);
          length = count + chunks.length;
        },
      },
    };
  };

  /** The messages on `id`'s log after the one `position` names, oldest first. */
  const readMailbox = async (
    id: string,
    position: string | undefined,
  ): Promise<readonly EntityMessage[]> => {
    const from = position === undefined ? undefined : (JSON.parse(position) as Position);
    let cursor = from?.c ?? undefined;
    let skipping = from?.e !== undefined && from.e !== null;
    const messages: EntityMessage[] = [];
    // Where the read ended: past the last event of its last page.
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
        const sent = JSON.parse(decoder.decode(payload)) as { via?: string; body: unknown };
        messages.push({
          body: sent.body,
          id: JSON.stringify({ c: pageStart, e: event.eventId } satisfies Position),
          ...(sent.via !== undefined && { via: sent.via }),
        });
      }
      end = page.cursor ?? end;
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

  const streamLength = async (key: string): Promise<number> =>
    (await world.streams.getInfo(runId(key), streamNameOf(kind, key))).tailIndex + 1;

  const hookOf = async (token: string) => {
    if (world.hooks === undefined) throw new Error("This World has no hooks to send through.");
    try {
      return await world.hooks.getByToken(token);
    } catch (error) {
      if (isHookNotFound(error)) return undefined;
      throw error;
    }
  };

  return {
    newKey: () => `${kind.kind}_${createUlid()}`,
    async create(key, createOptions) {
      const writer = await createRun(world, kind, key, createOptions.meta);
      if (writer === undefined) throw new Error(`The World holds "${key}" already.`);
      const tokens = new Set([keyToken(runId(key)), ...(createOptions.aliases ?? [])]);
      for (const token of tokens) await createHook(key, writer, token);
    },
    meta: async (key) => await readMeta(world, runId(key)),
    async lookup(alias) {
      const hook = await hookOf(alias);
      return hook === undefined ? undefined : keyOfRun(kind, hook.runId);
    },
    async send(to, body) {
      const hook = await hookOf("alias" in to ? to.alias : keyToken(runId(to.key)));
      const key = hook === undefined ? undefined : keyOfRun(kind, hook.runId);
      if (hook === undefined || key === undefined) return undefined;
      const sent = { body, ...("alias" in to && { via: to.alias }) };
      // Written from outside the entity's run: out of band, so the World doesn't count it
      // against the fence of the writer running it.
      await world.events.create(
        hook.runId,
        {
          correlationId: hook.hookId,
          eventData: { payload: encoder.encode(JSON.stringify(sent)) },
          eventType: "hook_received",
          specVersion: 9,
        },
        { inBand: false },
      );
      await activation?.wake(key);
      return { key };
    },
    open: async (key) => await openHandle(key, await readMeta(world, runId(key))),
    async load(key) {
      const journal = await readJournal(world, runId(key));
      return journal === undefined
        ? undefined
        : { after: journal.after, snapshot: journal.snapshot };
    },
    streamLength,
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
        for (const chunk of page.data) chunks.push(chunk.data);
        cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
      } while (cursor !== undefined);
      return chunks;
    },
    read(key, from = 0) {
      const id = runId(key);
      const name = streamNameOf(kind, key);
      const tail = async () => (await streamLength(key)) - 1;
      return world.streams.get === undefined
        ? polledRead(world, id, name, from, tail)
        : liveRead(world, id, name, from, tail, world.streams.get.bind(world.streams));
    },
    list: async () => await listRuns(world, kind),
    once: async (name, occurrence) => await claimOnce(world, name, occurrence),
    ...(activation !== undefined && { activation }),
  };
}
