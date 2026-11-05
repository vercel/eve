import type { Entities, EntityHandle } from "#execution/entity/entities.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import { createUlid } from "#shared/ulid.js";
import {
  appendRecord,
  claimRun,
  createRun,
  type EntityKind,
  listRuns,
  readJournal,
  readMeta,
  runIdOf,
  STREAM_RECORD,
  streamNameOf,
} from "./runs.js";
import { polledRead } from "./stream-read.js";

// Entities on today's Worlds (`runs.ts` has the run underneath). The stream is the run's stream;
// a write is announced first by a fenced record, so a writer another one took over never writes
// it.

export type WorldEntitiesOptions = EntityKind;

export function worldEntities(world: RuntimeWorld, options: WorldEntitiesOptions): Entities {
  const kind: EntityKind = options;
  const runId = (key: string) => runIdOf(kind, key);

  const streamLength = async (key: string): Promise<number> =>
    (await world.streams.getInfo(runId(key), streamNameOf(kind, key))).tailIndex + 1;

  /** A handle on `key`, whose run exists (`meta` read) or is created here. */
  const openHandle = async (key: string, knownMeta?: unknown): Promise<EntityHandle> => {
    const id = runId(key);
    const created = knownMeta === undefined ? await createRun(world, kind, key, {}) : undefined;
    const writer = created ?? (await claimRun(world, key, id));
    const meta = created !== undefined ? {} : (knownMeta ?? (await readMeta(world, id)));
    let length: number | undefined;
    return {
      key,
      meta,
      async load() {
        const journal = await readJournal(world, id);
        return { after: journal?.after ?? [], snapshot: journal?.snapshot };
      },
      async append(records, appendOptions = {}) {
        for (const [index, record] of records.entries()) {
          const last = index === records.length - 1;
          await appendRecord(world, key, id, writer, record, {
            ...(last && appendOptions.snapshot === true && { s: true }),
          });
        }
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

  return {
    newKey: () => `${kind.kind}_${createUlid()}`,
    async create(key, createOptions) {
      if ((await createRun(world, kind, key, createOptions.meta)) === undefined)
        throw new Error(`The World holds "${key}" already.`);
    },
    meta: async (key) => await readMeta(world, runId(key)),
    open: async (key) => await openHandle(key, await readMeta(world, runId(key))),
    async load(key) {
      return await readJournal(world, runId(key));
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
      return polledRead(world, id, name, from, tail);
    },
    list: async () => await listRuns(world, kind),
  };
}
