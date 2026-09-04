import { describe, expect, it } from "vitest";

import { equalSnapshot } from "#execution/session/snapshot-equality.js";

describe("snapshot write identity", () => {
  it("compares file bytes even when file metadata and length match", async () => {
    const left = { attachment: new File(["one"], "note.txt", { lastModified: 1 }) };
    const right = { attachment: new File(["two"], "note.txt", { lastModified: 1 }) };
    expect(await equalSnapshot(left, right)).toBe(false);
    expect(
      await equalSnapshot(left, { attachment: new File(["one"], "note.txt", { lastModified: 1 }) }),
    ).toBe(true);
  });

  it("handles nested maps and cyclic durable values", async () => {
    const value = new Map<string, unknown>([["file", new Blob(["data"])]]);
    value.set("self", value);
    expect(await equalSnapshot(value, structuredClone(value))).toBe(true);
    const different = new Map<string, unknown>([["file", new Blob(["else"])]]);
    different.set("self", different);
    expect(await equalSnapshot(value, different)).toBe(false);
  });
});
