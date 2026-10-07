import { describe, expect, it } from "vitest";

import { applyVercelWorkflowWorldDefaults } from "#internal/workflow/vercel-world-defaults.js";

describe("applyVercelWorkflowWorldDefaults", () => {
  it("batches event bursts without changing the world's other settings", () => {
    const streams = {};
    const world: { streams: object; streamFlushIntervalMs?: number } = { streams };
    applyVercelWorkflowWorldDefaults(world, {});
    expect(world).toEqual({ streams, streamFlushIntervalMs: 10 });
    expect(world.streams).toBe(streams);
  });

  it.each([0, 5, 25])("preserves an explicit %i ms window", (streamFlushIntervalMs) => {
    const world = { streamFlushIntervalMs };
    applyVercelWorkflowWorldDefaults(world, {});
    expect(world.streamFlushIntervalMs).toBe(streamFlushIntervalMs);
  });

  it.each([undefined, ""])("defaults the stream transport to ws when unset (%j)", (value) => {
    const env: Record<string, string | undefined> = { WORKFLOW_STREAMS_TRANSPORT: value };
    applyVercelWorkflowWorldDefaults({}, env);
    expect(env.WORKFLOW_STREAMS_TRANSPORT).toBe("ws");
  });

  it("preserves operator-supplied stream and event transports", () => {
    const env = { WORKFLOW_STREAMS_TRANSPORT: "http", WORKFLOW_EVENTS_TRANSPORT: "http" };
    applyVercelWorkflowWorldDefaults({}, env);
    expect(env.WORKFLOW_STREAMS_TRANSPORT).toBe("http");
    expect(env.WORKFLOW_EVENTS_TRANSPORT).toBe("http");
  });
});
