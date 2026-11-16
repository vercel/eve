import { describe, expect, it } from "vitest";

import { matchesHostTracedDependency } from "#internal/host-traced-dependencies.js";

describe("matchesHostTracedDependency", () => {
  it("matches configured names exactly and extension patterns by prefix", () => {
    const traced = ["sharp", "zod*"];

    expect(matchesHostTracedDependency("sharp", traced)).toBe(true);
    expect(matchesHostTracedDependency("sharp-cli", traced)).toBe(false);
    expect(matchesHostTracedDependency("zod", traced)).toBe(true);
    expect(matchesHostTracedDependency("zod-to-json-schema", traced)).toBe(true);
    expect(matchesHostTracedDependency("ai", traced)).toBe(false);
    expect(matchesHostTracedDependency("ai", [])).toBe(false);
  });
});
