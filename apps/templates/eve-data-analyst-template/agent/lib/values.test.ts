import { describe, expect, it } from "vitest";

import { withRecentEntry } from "./values";

describe(withRecentEntry, () => {
  it("keeps the newest entries in insertion order", () => {
    expect(withRecentEntry({ a: 1, b: 2, c: 3 }, "d", 4, 3)).toEqual({
      b: 2,
      c: 3,
      d: 4,
    });
    expect(
      Object.keys(withRecentEntry({ a: 1, b: 2, c: 3 }, "d", 4, 3))
    ).toEqual(["b", "c", "d"]);
  });

  it("moves a re-added key to the end without duplicating it", () => {
    const next = withRecentEntry({ a: 1, b: 2, c: 3 }, "a", 9, 3);
    expect(Object.entries(next)).toEqual([
      ["b", 2],
      ["c", 3],
      ["a", 9],
    ]);
  });

  it("leaves the input unchanged", () => {
    const current = { a: 1 };
    withRecentEntry(current, "b", 2, 1);
    expect(current).toEqual({ a: 1 });
  });
});
