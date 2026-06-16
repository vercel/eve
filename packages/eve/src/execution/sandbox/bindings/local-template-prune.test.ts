import { describe, expect, it } from "vitest";

import { selectStaleTemplateEntries } from "#execution/sandbox/bindings/local-template-prune.js";

describe("selectStaleTemplateEntries", () => {
  const now = 100_000;

  it("keeps the retained most-recent entries regardless of age", () => {
    const entries = [
      { mtimeMs: 10, name: "oldest" },
      { mtimeMs: 50_000, name: "middle" },
      { mtimeMs: 99_000, name: "newest" },
    ];

    const stale = selectStaleTemplateEntries(entries, {
      now,
      recentWindowMs: 1_000,
      retainCount: 2,
    });

    expect(stale.map((entry) => entry.name)).toEqual(["oldest"]);
  });

  it("keeps entries inside the recency window even beyond the retain count", () => {
    const entries = [
      { mtimeMs: now - 500, name: "recent-a" },
      { mtimeMs: now - 600, name: "recent-b" },
      { mtimeMs: now - 700, name: "recent-c" },
    ];

    const stale = selectStaleTemplateEntries(entries, {
      now,
      recentWindowMs: 1_000,
      retainCount: 1,
    });

    expect(stale).toEqual([]);
  });

  it("returns everything outside both protections", () => {
    const entries = [
      { mtimeMs: 10, name: "a" },
      { mtimeMs: 20, name: "b" },
    ];

    const stale = selectStaleTemplateEntries(entries, {
      now,
      recentWindowMs: 1_000,
      retainCount: 0,
    });

    expect(stale.map((entry) => entry.name)).toEqual(["b", "a"]);
  });
});
