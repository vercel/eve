import { describe, expect, it } from "vitest";

import {
  AliasTakenError,
  type ActivationOutcome,
  type Actors,
  type ActorHandle,
  isTakenOver,
} from "./actors.js";

// The conformance suite of `actors.ts`: its guarantees as tests, for any implementation on any
// World. `describeActors` runs them against what `make` returns; a World without a mailbox or a
// queue skips what needs one, which says so. A native implementation that passes this suite can
// replace ours.

export interface ActorsUnderTest {
  readonly actors: Actors;
  /** Its own handle on the same World, as another process would have. */
  readonly elsewhere: () => Actors;
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

export function describeActors(name: string, make: () => Promise<ActorsUnderTest>): void {
  const withActors =
    (test: (under: ActorsUnderTest) => Promise<void>) => async (): Promise<void> => {
      const under = await make();
      try {
        await test(under);
      } finally {
        await under.close();
      }
    };

  describe(`actors on ${name}`, () => {
    it(
      "keeps a journal, and loads it from its latest snapshot on",
      withActors(async ({ actors }) => {
        const key = actors.newKey();
        const handle = await actors.open(key);
        await handle.append([{ kind: "test.state", value: 1 }], { snapshot: true });
        await handle.append([{ kind: "test.change", value: 2 }]);
        await handle.append([{ kind: "test.state", value: 3 }], { snapshot: true });
        await handle.append([
          { kind: "test.change", value: 4 },
          { kind: "test.change", value: 5 },
        ]);
        const loaded = await actors.load(key);
        expect(loaded?.snapshot).toEqual({ kind: "test.state", value: 3 });
        expect(loaded?.after).toEqual([
          { kind: "test.change", value: 4 },
          { kind: "test.change", value: 5 },
        ]);
        expect(await actors.load(actors.newKey())).toBeUndefined();
      }),
    );

    it(
      "keeps values by name, beside the journal: a reader anywhere reads the latest",
      withActors(async ({ actors, elsewhere }) => {
        const key = actors.newKey();
        const handle = await actors.open(key);
        expect(await actors.value(key, "child.a")).toBeUndefined();
        await handle.keep("child.a", text("first"));
        await handle.keep("child.a", text("second"));
        await handle.keep("child.b", text("other"));
        const decode = (value: Uint8Array | undefined) =>
          value === undefined ? undefined : new TextDecoder().decode(value);
        expect(decode(await elsewhere().value(key, "child.a"))).toBe("second");
        expect(decode(await actors.value(key, "child.b"))).toBe("other");
        expect(await actors.value(actors.newKey(), "child.a")).toBeUndefined();
      }),
    );

    it(
      "keeps one writer: opening an actor fences out whoever held it, who writes nothing more",
      withActors(async ({ actors, elsewhere }) => {
        const key = actors.newKey();
        const first = await actors.open(key);
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
        expect((await actors.load(key))?.after).toEqual([{ kind: "test.change", value: "second" }]);
        expect((await actors.chunks(key)).map((chunk) => new TextDecoder().decode(chunk))).toEqual([
          "a",
        ]);
      }),
    );

    it(
      "keeps a stream: chunks at the position given, read from any position, and followed live",
      withActors(async ({ actors }) => {
        const key = actors.newKey();
        const handle = await actors.open(key);
        await handle.stream.append(0, [text("0"), text("1"), text("2")]);
        await expect(handle.stream.append(1, [text("x")])).rejects.toThrow();
        expect(await actors.streamLength(key)).toBe(3);
        const from = actors.read(key, 1);
        const following = readAll(from, 3);
        await handle.stream.append(3, [text("3")]);
        expect(await following).toEqual(["1", "2", "3"]);
        expect(await readAll(actors.read(key, -2), 2)).toEqual(["2", "3"]);
      }),
    );

    it(
      "runs `once` for one caller per occurrence",
      withActors(async ({ actors, elsewhere }) => {
        const occurrence = Math.floor(Date.now() / 60_000) * 60_000;
        const results = await Promise.all([
          actors.once("conformance", occurrence),
          elsewhere().once("conformance", occurrence),
          actors.once("conformance", occurrence),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await actors.once("conformance", occurrence + 60_000)).toBe(true);
      }),
    );

    describe("with a mailbox", () => {
      it(
        "keeps what was created, and reaches an actor by its aliases",
        withActors(async (under) => {
          if (!under.mailbox) return;
          const { actors } = under;
          const key = actors.newKey();
          await actors.create(key, { aliases: ["conformance-alias"], meta: { agent: "a" } });
          expect(await actors.meta(key)).toEqual({ agent: "a" });
          expect(await actors.lookup("conformance-alias")).toBe(key);
          expect(await actors.lookup("nobody")).toBeUndefined();
          await expect(actors.create(key, { meta: {} })).rejects.toThrow();
          // An alias reaches one actor: another created with it is refused, and it still
          // reaches the first.
          await expect(
            actors.create(actors.newKey(), { aliases: ["conformance-alias"], meta: {} }),
          ).rejects.toThrow(AliasTakenError);
          expect(await actors.lookup("conformance-alias")).toBe(key);
          expect((await actors.list()).map((actor) => actor.key)).toContain(key);
        }),
      );

      it(
        "frees an actor's aliases once it ends, and deletes what it kept when asked to",
        withActors(async (under) => {
          if (!under.mailbox) return;
          const { actors } = under;
          const kept = actors.newKey();
          await actors.create(kept, { aliases: ["conformance-ends"], meta: { n: 1 } });
          const handle = await actors.open(kept);
          await handle.append([{ kind: "test.state", value: "kept" }], { snapshot: true });
          await handle.end();
          expect(await actors.lookup("conformance-ends")).toBeUndefined();
          expect(await actors.send({ alias: "conformance-ends" }, {})).toBeUndefined();
          // Another actor may take the alias now.
          const next = actors.newKey();
          await actors.create(next, { aliases: ["conformance-ends"], meta: {} });
          expect(await actors.lookup("conformance-ends")).toBe(next);
          // An actor that ended keeps what it had, unless it was created to purge it.
          expect((await actors.load(kept))?.snapshot?.value).toBe("kept");
          const purged = actors.newKey();
          await actors.create(purged, { meta: {}, purgeOnEnd: true });
          const writer = await actors.open(purged);
          await writer.append([{ kind: "test.state", value: "secret" }], { snapshot: true });
          await writer.stream.append(0, [text("secret")]);
          await writer.end();
          const after = await actors.load(purged).then(
            (journal) => journal?.snapshot?.value,
            () => undefined,
          );
          expect(after).toBeUndefined();
          expect(await actors.purged(purged)).toBe(true);
          expect(await actors.purged(kept)).toBe(false);
          const lines = await actors.chunks(purged).then(
            (chunks) => chunks.length,
            () => 0,
          );
          expect(lines).toBe(0);
        }),
      );

      it(
        "hands each message over until a write consumes it, in the order it was sent",
        withActors(async (under) => {
          if (!under.mailbox) return;
          const { actors, elsewhere } = under;
          const key = actors.newKey();
          await actors.create(key, { aliases: ["conformance-to"], meta: {} });
          await elsewhere().send({ alias: "conformance-to" }, { n: 1 });
          await elsewhere().send({ key }, { n: 2 });
          expect(await actors.send({ alias: "nobody" }, {})).toBeUndefined();

          const first = await actors.open(key);
          const messages = await first.inbox();
          expect(messages.map((message) => message.body)).toEqual([{ n: 1 }, { n: 2 }]);
          expect(messages.map((message) => message.via)).toEqual(["conformance-to", undefined]);
          // Taken into the journal, consuming the first in the same write; then "crashes".
          await first.append([{ kind: "test.input", value: 1 }], {
            consumedThrough: messages[0]!.id,
          });

          // The next writer gets what the first didn't consume, and what arrived since.
          await elsewhere().send({ key }, { n: 3 });
          const next: ActorHandle = await elsewhere().open(key);
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
        "activates an actor on each message, one activation at a time, and again on `continue`",
        withActors(async (under) => {
          if (!under.queue) return;
          const { actors } = under;
          const activation = actors.activation!;
          const key = actors.newKey();
          await actors.create(key, { meta: { n: 0 } });
          const seen: unknown[] = [];
          let running = 0;
          let overlapped = false;
          let continued = false;
          let activations = 0;
          const consumer = activation.consumer(
            async (actor) => {
              activations += 1;
              running += 1;
              overlapped ||= running > 1;
              try {
                const messages = await actor.inbox();
                for (const message of messages) {
                  seen.push(message.body);
                  await actor.append([], { consumedThrough: message.id });
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
          for (const message of ["a", "b", "c"]) await actors.send({ key }, message);
          // Continued once it had a message: activated again after that.
          await untilOf(() => seen.length === 3 && continued && activations >= 2 && running === 0);
          expect(seen).toEqual(["a", "b", "c"]);
          expect(overlapped).toBe(false);
          expect(continued).toBe(true);
        }),
      );

      it(
        "hands a message sent while an activation runs to that activation, promptly, through its watch",
        withActors(async (under) => {
          if (!under.queue) return;
          const { actors, elsewhere } = under;
          const key = actors.newKey();
          await actors.create(key, { meta: {} });
          let activations = 0;
          let sentAt = 0;
          let readAt = 0;
          let watching!: () => void;
          const watched = new Promise<void>((resolve) => (watching = resolve));
          const consumer = actors.activation!.consumer(
            async (actor) => {
              activations += 1;
              const read: unknown[] = [];
              const take = async () => {
                const messages = await actor.inbox();
                for (const message of messages) read.push(message.body);
                const last = messages.at(-1);
                if (last !== undefined) await actor.append([], { consumedThrough: last.id });
              };
              await take();
              if (activations > 1) return { kind: "idle" };
              // The first activation works on, and reads what arrives on each hint.
              let arrived!: () => void;
              const arrival = new Promise<void>((resolve) => (arrived = resolve));
              const stop = actor.watchInbox(() => {
                void take().then(() => {
                  if (read.includes("mid-activation")) arrived();
                });
              });
              watching();
              try {
                await arrival;
                readAt = Date.now();
              } finally {
                stop();
              }
              return { kind: "idle" };
            },
            { budgetMs: 30_000 },
          );
          await consumer.serve();
          await actors.activation!.wake(key);
          await watched;
          sentAt = Date.now();
          await elsewhere().send({ key }, "mid-activation");
          await untilOf(() => readAt > 0);
          // Read by the activation that was running, well before its slow fallback would have.
          expect(readAt - sentAt).toBeLessThan(2_000);
          // The message's own wake may still activate the actor once more, which finds nothing.
        }),
      );

      it(
        "activates an actor again at or after its alarm, and not before",
        withActors(async (under) => {
          if (!under.queue) return;
          const { actors } = under;
          const key = actors.newKey();
          await actors.create(key, { meta: {} });
          const activated: number[] = [];
          let alarm = 0;
          const consumer = actors.activation!.consumer(
            async () => {
              activated.push(Date.now());
              if (activated.length > 1) return { kind: "idle" };
              alarm = Date.now() + 1_500;
              return { alarm, kind: "idle" };
            },
            { budgetMs: 5_000 },
          );
          await consumer.serve();
          await actors.activation!.wake(key);
          await untilOf(() => activated.length === 2);
          expect(activated[1]!).toBeGreaterThanOrEqual(alarm);
        }),
      );
    });
  });
}
