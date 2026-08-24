import { describe, expect, it } from "vitest";

import type { CompiledChannel } from "#channel/compiled-channel.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import createHomeChannel from "#framework-sources/channels/home.js";
import { attachRouteAgentName } from "#channel/route-context.js";

describe("framework home channel", () => {
  it("serves the current home contract with the runtime agent identity", async () => {
    const channel = createHomeChannel() as CompiledChannel;
    const route = channel.routes[0];
    if (route === undefined || route.transport !== "http") throw new Error("Missing home route.");
    const args = attachRouteAgentName({} as RouteHandlerArgs, "support-agent");

    const response = await route.handler(new Request("https://agent.example/"), args);

    expect(route.method).toBe("GET");
    expect(route.path).toBe("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain("support-agent");
  });
});
