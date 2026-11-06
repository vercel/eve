import { describe, expect, it } from "vitest";

import {
  AliasTakenError,
  type ActivationOutcome,
  type Entities,
  type EntityHandle,
  isTakenOver,
} from "./entities.js";

// The conformance suite of `entities.ts`: its guarantees as tests, for any implementation on any
// World. `describeEntities` runs them against what `make` returns; a World without a mailbox or a
// queue skips what needs one, which says so. A native implementation that passes this suite can
// replace ours.

export interface EntitiesUnderTest {
  readonly entities: Entities;
  /** Its own handle on the same World, as another process would have. */
  readonly elsewhere: () => Entities;
  /** Whether the World has a mailbox (hooks) and a queue (activation). */
  readonly mailbox: boolean;
  readonly queue: boolean;
  close(): Promise<void>;
}

const text = (value: string) => new TextEncoder().encode(value);
const untilOf = async (condition: () => boolean | Promise<boolean>, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

async function readAll(stream: ReadableStream<Uint8Array>, count: number): Promise<string[]> {
  const reader = stream.getReader();
  const read: string[] = [];
  const decoder = new TextDecoder();
  while (read.length < count) {
    const next = await reader.read();
    if (next.done) break;
    read.push(decoder.decode(next.value));
  }
  await reader.cancel();
  return read;
}

export function describeEntities(name: string, make: () => Promise<EntitiesUnderTest>): void {
  const withEntities =
    (test: (under: EntitiesUnderTest) => Promise<void>) => async (): Promise<void> => {
      const under = await make();
      try {
        await test(under);
      } finally {
        await under.close();
      }
    };

  describe(`entities on ${name}`, () => {
    it(
      "keeps a journal, and loads it from its latest snapshot on",
      withEntities(async ({ entities }) => {
        const key = entities.newKey();
        const handle = await entities.open(key);
        await handle.append([{ kind: "test.state", value: 1 }], { snapshot: true });
        await handle.append([{ kind: "test.change", value: 2 }]);
        await handle.append([{ kind: "test.state", value: 3 }], { snapshot: true });
        await handle.append([
          { kind: "test.change", value: 4 },
          { kind: "test.change", value: 5 },
        ]);
        const loaded = await entities.load(key);
        expect(loaded?.snapshot).toEqual({ kind: "test.state", value: 3 });
        expect(loaded?.after).toEqual([
          { kind: "test.change", value: 4 },
          { kind: "test.change", value: 5 },
        ]);
        expect(await entities.load(entities.newKey())).toBeUndefined();
      }),
    );

    it(
      "keeps one writer: opening an entity fences out whoever held it, who writes nothing more",
      withEntities(async ({ entities, elsewhere }) => {
        const key = entities.newKey();
        const first = await entities.open(key);
        await first.append([{ kind: "test.state", value: "first" }], { snapshot: true });
        await first.stream.append(0, [text("a")]);
        const second = await elsewhere().open(key);
        const refused = async (write: () => Promise<unknown>) =>
          await write().then(
            () => false,
            (error: unknown) => isTakenOver(error),
          );
        expect(await refused(() => first.append([{ kind: "test.change", value: "late" }]))).toBe(
          true,
        );
        expect(await refused(() => first.stream.append(1, [text("late")]))).toBe(true);
        await second.append([{ kind: "test.change", value: "second" }]);
        expect((await entities.load(key))?.after).toEqual([
          { kind: "test.change", value: "second" },
        ]);
        expect(
          (await entities.chunks(key)).map((chunk) => new TextDecoder().decode(chunk)),
        ).toEqual(["a"]);
      }),
    );

    it(
      "keeps a stream: chunks at the position given, read from any position, and followed live",
      withEntities(async ({ entities }) => {
        const key = entities.newKey();
        const handle = await entities.open(key);
        await handle.stream.append(0, [text("0"), text("1"), text("2")]);
        await expect(handle.stream.append(1, [text("x")])).rejects.toThrow();
        expect(await entities.streamLength(key)).toBe(3);
        const from = entities.read(key, 1);
        const following = readAll(from, 3);
        await handle.stream.append(3, [text("3")]);
        expect(await following).toEqual(["1", "2", "3"]);
        expect(await readAll(entities.read(key, -2), 2)).toEqual(["2", "3"]);
      }),
    );

    it(
      "runs `once` for one caller per occurrence",
      withEntities(async ({ entities, elsewhere }) => {
        const occurrence = Math.floor(Date.now() / 60_000) * 60_000;
        const results = await Promise.all([
          entities.once("conformance", occurrence),
          elsewhere().once("conformance", occurrence),
          entities.once("conformance", occurrence),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await entities.once("conformance", occurrence + 60_000)).toBe(true);
      }),
    );

    describe("with a mailbox", () => {
      it(
        "keeps what was created, and reaches an entity by its aliases",
        withEntities(async (under) => {
          if (!under.mailbox) return;
          const { entities } = under;
          const key = entities.newKey();
          await entities.create(key, { aliases: ["conformance-alias"], meta: { agent: "a" } });
          expect(await entities.meta(key)).toEqual({ agent: "a" });
          expect(await entities.lookup("conformance-alias")).toBe(key);
          expect(await entities.lookup("nobody")).toBeUndefined();
          await expect(entities.create(key, { meta: {} })).rejects.toThrow();
          // An alias reaches one entity: another created with it is refused, and it still
          // reaches the first.
          await expect(
            entities.create(entities.newKey(), { aliases: ["conformance-alias"], meta: {} }),
          ).rejects.toThrow(AliasTakenError);
          expect(await entities.lookup("conformance-alias")).toBe(key);
          expect((await entities.list()).map((entity) => entity.key)).toContain(key);
        }),
      );

      it(
        "frees an entity's aliases once it ends, and deletes what it kept when asked to",
        withEntities(async (under) => {
          if (!under.mailbox) return;
          const { entities } = under;
          const kept = entities.newKey();
          await entities.create(kept, { aliases: ["conformance-ends"], meta: { n: 1 } });
          const handle = await entities.open(kept);
          await handle.append([{ kind: "test.state", value: "kept" }], { snapshot: true });
          await handle.end();
          expect(await entities.lookup("conformance-ends")).toBeUndefined();
          expect(await entities.send({ alias: "conformance-ends" }, {})).toBeUndefined();
          // Another entity may take the alias now.
          const next = entities.newKey();
          await entities.create(next, { aliases: ["conformance-ends"], meta: {} });
          expect(await entities.lookup("conformance-ends")).toBe(next);
          // An entity that ended keeps what it had, unless it was created to purge it.
          expect((await entities.load(kept))?.snapshot?.value).toBe("kept");
          const purged = entities.newKey();
          await entities.create(purged, { meta: {}, purgeOnEnd: true });
          const writer = await entities.open(purged);
          await writer.append([{ kind: "test.state", value: "secret" }], { snapshot: true });
          await writer.stream.append(0, [text("secret")]);
          await writer.end();
          const after = await entities.load(purged).then(
            (journal) => journal?.snapshot?.value,
            () => undefined,
          );
          expect(after).toBeUndefined();
          expect(await entities.purged(purged)).toBe(true);
          expect(await entities.purged(kept)).toBe(false);
          const lines = await entities.chunks(purged).then(
            (chunks) => chunks.length,
            () => 0,
          );
          expect(lines).toBe(0);
        }),
      );

      it(
        "hands each message over until a write consumes it, in the order it was sent",
        withEntities(async (under) => {
          if (!under.mailbox) return;
          const { entities, elsewhere } = under;
          const key = entities.newKey();
          await entities.create(key, { aliases: ["conformance-to"], meta: {} });
          await elsewhere().send({ alias: "conformance-to" }, { n: 1 });
          await elsewhere().send({ key }, { n: 2 });
          expect(await entities.send({ alias: "nobody" }, {})).toBeUndefined();

          const first = await entities.open(key);
          const messages = await first.inbox();
          expect(messages.map((message) => message.body)).toEqual([{ n: 1 }, { n: 2 }]);
          expect(messages.map((message) => message.via)).toEqual(["conformance-to", undefined]);
          // Taken into the journal, consuming the first in the same write; then "crashes".
          await first.append([{ kind: "test.input", value: 1 }], {
            consumedThrough: messages[0]!.id,
          });

          // The next writer gets what the first didn't consume, and what arrived since.
          await elsewhere().send({ key }, { n: 3 });
          const next: EntityHandle = await elsewhere().open(key);
          await next.load();
          const rest = await next.inbox();
          expect(rest.map((message) => message.body)).toEqual([{ n: 2 }, { n: 3 }]);
          await next.append([], { consumedThrough: rest.at(-1)!.id });
          expect(await next.inbox()).toEqual([]);

          // A snapshot keeps where the mailbox was consumed: a later writer starts there.
          await next.append([{ kind: "test.state", value: "s" }], { snapshot: true });
          const later = await elsewhere().open(key);
          expect(await later.inbox()).toEqual([]);
        }),
      );
    });

    describe("with a queue", () => {
      it(
        "activates an entity on each message, one activation at a time, and again on `continue`",
        withEntities(async (under) => {
          if (!under.queue) return;
          const { entities } = under;
          const activation = entities.activation!;
          const key = entities.newKey();
          await entities.create(key, { meta: { n: 0 } });
          const seen: unknown[] = [];
          let running = 0;
          let overlapped = false;
          let continued = false;
          let activations = 0;
          const consumer = activation.consumer(
            async (entity) => {
              activations += 1;
              running += 1;
              overlapped ||= running > 1;
              try {
                const messages = await entity.inbox();
                for (const message of messages) {
                  seen.push(message.body);
                  await entity.append([], { consumedThrough: message.id });
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
                if (!continued && seen.length > 0) {
                  continued = true;
                  return { kind: "continue" } satisfies ActivationOutcome;
                }
                return { kind: "idle" } satisfies ActivationOutcome;
              } finally {
                running -= 1;
              }
            },
            { budgetMs: 5_000 },
          );
          await consumer.serve();
          // One after another: the order they're sent in is the order they're handed over.
          for (const message of ["a", "b", "c"]) await entities.send({ key }, message);
          // Continued once it had a message: activated again after that.
          await untilOf(() => seen.length === 3 && continued && activations >= 2 && running === 0);
          expect(seen).toEqual(["a", "b", "c"]);
          expect(overlapped).toBe(false);
          expect(continued).toBe(true);
        }),
      );

      it(
        "activates an entity again at or after its alarm, and not before",
        withEntities(async (under) => {
          if (!under.queue) return;
          const { entities } = under;
          const key = entities.newKey();
          await entities.create(key, { meta: {} });
          const activated: number[] = [];
          let alarm = 0;
          const consumer = entities.activation!.consumer(
            async () => {
              activated.push(Date.now());
              if (activated.length > 1) return { kind: "idle" };
              alarm = Date.now() + 1_500;
              return { alarm, kind: "idle" };
            },
            { budgetMs: 5_000 },
          );
          await consumer.serve();
          await entities.activation!.wake(key);
          await untilOf(() => activated.length === 2);
          expect(activated[1]!).toBeGreaterThanOrEqual(alarm);
        }),
      );
    });
  });
}
