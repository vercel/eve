import { describe, expect, it } from "vitest";

import { MemoryDocumentConflictError } from "#public/memory/file/backend.js";
import { inMemory } from "#public/memory/file/backends/in-memory.js";

const signal = new AbortController().signal;

describe("inMemory file-memory backend", () => {
  it("reads and conditionally replaces isolated documents", async () => {
    const backend = inMemory();

    expect(await backend.read({ key: "a", signal })).toBeNull();
    const first = await backend.write({
      content: "first",
      expectedVersion: null,
      key: "a",
      signal,
    });
    const second = await backend.write({
      content: "second",
      expectedVersion: first.version,
      key: "a",
      signal,
    });

    expect(second.version).not.toBe(first.version);
    expect(await backend.read({ key: "a", signal })).toEqual(second);
    expect(await backend.read({ key: "b", signal })).toBeNull();
  });

  it("rejects stale and duplicate-create writes", async () => {
    const backend = inMemory();
    await backend.write({ content: "first", expectedVersion: null, key: "a", signal });

    await expect(
      backend.write({ content: "duplicate", expectedVersion: null, key: "a", signal }),
    ).rejects.toSatisfy(MemoryDocumentConflictError.is);
    await expect(
      backend.write({ content: "stale", expectedVersion: "old", key: "a", signal }),
    ).rejects.toSatisfy(MemoryDocumentConflictError.is);
  });

  it("honors cancellation before touching the store", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const backend = inMemory();

    await expect(backend.read({ key: "a", signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
  });
});
