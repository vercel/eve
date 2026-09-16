import { describe, expect, it } from "vitest";

import { applyVercelWorkflowWorldDefaults } from "#internal/workflow/vercel-world-defaults.js";

describe("applyVercelWorkflowWorldDefaults", () => {
  it("batches event bursts without changing the world's other settings", () => {
    const streams = {};
    const world: { streams: object; streamFlushIntervalMs?: number } = { streams };
    applyVercelWorkflowWorldDefaults(world);
    expect(world).toEqual({ streams, streamFlushIntervalMs: 10 });
    expect(world.streams).toBe(streams);
  });

  it.each([0, 5, 25])("preserves an explicit %i ms window", (streamFlushIntervalMs) => {
    const world = { streamFlushIntervalMs };
    applyVercelWorkflowWorldDefaults(world);
    expect(world.streamFlushIntervalMs).toBe(streamFlushIntervalMs);
  });
});
