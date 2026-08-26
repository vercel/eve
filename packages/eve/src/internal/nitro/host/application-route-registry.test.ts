import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import { createApplicationRouteRegistry } from "#internal/nitro/host/application-route-registry.js";
import {
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_HEALTH_ROUTE_PATH,
  EVE_INFO_ROUTE_PATH,
} from "#protocol/routes.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#internal/workflow-bundle/eve-service-route-output.js";

describe("createApplicationRouteRegistry", () => {
  it("projects the compiler-owned channel route plan", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const registry = createApplicationRouteRegistry({ compileResult: { manifest } });

    expect(registry.channelRegistrations).toEqual(
      manifest.channelRoutes.effective.map((route) => ({
        cors: route.cors,
        method: route.method,
        route: route.urlPath,
      })),
    );
    expect(registry.channelRoutes).toContainEqual({
      cors: undefined,
      kind: "channel",
      method: "GET",
      path: EVE_HEALTH_ROUTE_PATH,
    });
    expect(registry.channelRoutes).toContainEqual({
      cors: undefined,
      kind: "channel",
      method: "HEAD",
      path: EVE_HEALTH_ROUTE_PATH,
    });
    expect(registry.channelRoutes).toContainEqual(
      expect.objectContaining({ kind: "channel", method: "GET", path: EVE_INFO_ROUTE_PATH }),
    );
    expect(registry.routes.at(-1)).toEqual({
      kind: "workflow",
      method: "ALL",
      path: EVE_WORKFLOW_FLOW_ROUTE_PATH,
    });
  });

  it("adds only host-owned development routes in development", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const registry = createApplicationRouteRegistry(
      { compileResult: { manifest } },
      { development: true },
    );

    expect(registry.routes).toContainEqual({
      kind: "development-artifacts",
      method: "GET",
      path: EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
    });
    expect(registry.routes).toContainEqual({
      kind: "development-schedule",
      method: "POST",
      path: EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
    });
    expect(registry.routes.filter((route) => route.kind === "workflow")).toHaveLength(1);
  });
});
