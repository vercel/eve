import { describe, expect, it } from "vitest";

import type { CompiledChannel } from "#channel/compiled-channel.js";
import createHealthChannel from "#framework-sources/channels/eve/v1/health.js";

describe("framework health channel", () => {
  it.each(["GET", "HEAD"] as const)("serves the current %s health contract", async (method) => {
    const channel = createHealthChannel() as CompiledChannel;
    const route = channel.routes.find((candidate) => candidate.method === method);
    if (route === undefined || route.transport !== "http") {
      throw new Error(`Missing ${method} route.`);
    }

    const response = await route.handler(
      new Request("https://agent.example/eve/v1/health", { method }),
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: "ready",
      workflowId: expect.any(String),
    });
  });
});
