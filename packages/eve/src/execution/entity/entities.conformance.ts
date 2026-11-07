import { describe, expect, it } from "vitest";

import type { Entities } from "./entities.js";

// The conformance suite of `entities.ts`: its guarantees as tests, for any implementation on any
// World. `describeEntities` runs them against what `make` returns. A native implementation that
// passes this suite can replace ours.

export interface EntitiesUnderTest {
  readonly entities: Entities;
  /** Its own handle on the same World, as another process would have. */
  readonly elsewhere: () => Entities;
  close(): Promise<void>;
}

const text = (value: string) => new TextEncoder().encode(value);

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
      "keeps what an entity was created with, and lists entities newest first",
      withEntities(async ({ entities, elsewhere }) => {
        const first = entities.newKey();
        await entities.create(first, { meta: { name: "first" } });
        await expect(entities.create(first, { meta: {} })).rejects.toThrow();
        const second = entities.newKey();
        await entities.create(second, { meta: { name: "second" } });
        expect(await elsewhere().meta(first)).toEqual({ name: "first" });
        expect(await entities.meta(entities.newKey())).toBeUndefined();
        const keys = (await elsewhere().list()).map((entity) => entity.key);
        expect(keys.indexOf(second)).toBeLessThan(keys.indexOf(first));
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
  });
}
