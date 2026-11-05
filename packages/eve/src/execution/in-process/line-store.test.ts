import { describe, expect, it } from "vitest";

import { createMemoryLineStore } from "./line-store.js";

// A kept stream's lines are kept in batches: a reader sees only kept lines, lines written while a
// batch is being kept go in the next, and a barrier's write resolves once it's kept.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const line = (text: string) => encoder.encode(text);
const texts = (lines: readonly Uint8Array[]) => lines.map((bytes) => decoder.decode(bytes));

/** A `persist` whose writes resolve when the test says, recording each batch. */
function gatedPersist() {
  const batches: { position: number; lines: string[] }[] = [];
  const gates: (() => void)[] = [];
  return {
    batches,
    persist: async (position: number, lines: readonly Uint8Array[]) => {
      batches.push({ lines: texts(lines), position });
      await new Promise<void>((resolve) => gates.push(resolve));
    },
    /** Lets the oldest write still waiting resolve. */
    release: async () => {
      while (gates.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      gates.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  };
}

describe("a kept line store", () => {
  it("keeps lines written during a batch in the next batch, and shows readers only kept lines", async () => {
    const store = createMemoryLineStore();
    const gated = gatedPersist();
    const writer = store.open("s", [], gated.persist).getWriter();
    await writer.write(line("a"));
    await writer.write(line("b"));
    await writer.write(line("c"));
    // "a" went alone; "b" and "c" wait for it.
    expect(gated.batches).toEqual([{ lines: ["a"], position: 0 }]);
    expect(texts(store.recorded("s"))).toEqual([]);
    await gated.release();
    expect(texts(store.recorded("s"))).toEqual(["a"]);
    expect(gated.batches.at(-1)).toEqual({ lines: ["b", "c"], position: 1 });
    await gated.release();
    expect(texts(store.recorded("s"))).toEqual(["a", "b", "c"]);
  });

  it("resolves a barrier's write once it and the lines before it are kept", async () => {
    const store = createMemoryLineStore();
    const gated = gatedPersist();
    const writer = store
      .open("s", [], gated.persist, (bytes) => decoder.decode(bytes) === "barrier")
      .getWriter();
    await writer.write(line("a"));
    let barrierKept = false;
    const barrier = writer.write(line("barrier")).then(() => (barrierKept = true));
    await gated.release();
    expect(barrierKept).toBe(false);
    await gated.release();
    await barrier;
    expect(texts(store.recorded("s"))).toEqual(["a", "barrier"]);
  });

  it("flushes what was written, and closes once everything is kept", async () => {
    const store = createMemoryLineStore();
    const kept: string[][] = [];
    const writable = store.open("s", [line("old")], async (position, lines) => {
      expect(position).toBe(1 + kept.flat().length);
      kept.push(texts(lines));
    });
    const writer = writable.getWriter();
    for (const text of ["a", "b", "c"]) await writer.write(line(text));
    await store.flush("s");
    expect(texts(store.recorded("s"))).toEqual(["old", "a", "b", "c"]);
    await writer.write(line("d"));
    await writer.close();
    expect(kept.flat()).toEqual(["a", "b", "c", "d"]);
  });

  it("fails the writes after a batch that wasn't kept, and keeps nothing after it", async () => {
    const store = createMemoryLineStore();
    let calls = 0;
    const writer = store
      .open("s", [], async () => {
        calls += 1;
        throw new Error("the World refused it");
      })
      .getWriter();
    await writer.write(line("a"));
    await expect(store.flush("s")).rejects.toThrow("the World refused it");
    await expect(writer.write(line("b"))).rejects.toThrow("the World refused it");
    expect(calls).toBe(1);
    expect(store.recorded("s")).toEqual([]);
  });

  it("writes straight through without a store to keep lines", async () => {
    const store = createMemoryLineStore();
    const writer = store.open("s").getWriter();
    await writer.write(line("a"));
    expect(texts(store.recorded("s"))).toEqual(["a"]);
  });
});
