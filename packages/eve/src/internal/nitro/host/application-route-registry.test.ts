import { describe, expect, it } from "vitest";

import type { CompiledChannelDefinition } from "#compiler/manifest.js";
import { createApplicationRouteRegistryFromInput } from "#internal/nitro/host/application-route-registry.js";
import { buildAgentInfoResponse } from "#internal/nitro/routes/agent-info/build-agent-info-response.js";
import {
  createStubCompiledAgentManifest,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";
import { getHostRouteRegistrations } from "#protocol/host-route-inventory.js";

describe("createApplicationRouteRegistryFromInput", () => {
  it("projects the compiler route plan without selecting or deduplicating again", () => {
    const cors = { origin: ["https://example.com"] } as const;
    const registry = createApplicationRouteRegistryFromInput({
      channelRoutes: {
        effective: [
          {
            cors,
            kind: "channel",
            logicalPath: "channels/hooks.ts",
            method: "POST",
            name: "hooks",
            sourceId: "hooks",
            sourceKind: "module",
            urlPath: "/hooks/:id",
          },
          {
            kind: "channel",
            logicalPath: "channels/socket.ts",
            method: "WEBSOCKET",
            name: "socket",
            sourceId: "socket",
            sourceKind: "module",
            urlPath: "/socket/:room",
          },
          {
            kind: "channel",
            logicalPath: "channels/home.ts",
            method: "GET",
            name: "home",
            sourceId: "home",
            sourceKind: "module",
            urlPath: "/",
          },
          {
            kind: "channel",
            logicalPath: "channels/eve/v1/health.ts",
            method: "GET",
            name: "eve/v1/health",
            sourceId: "health",
            sourceKind: "module",
            urlPath: "/eve/v1/health",
          },
          {
            kind: "channel",
            logicalPath: "channels/eve/v1/health.ts",
            method: "HEAD",
            name: "eve/v1/health",
            sourceId: "health",
            sourceKind: "module",
            urlPath: "/eve/v1/health",
          },
        ],
        preflight: [{ cors, pathPattern: "/hooks/:id", sourceIds: ["hooks"] }],
        shadowed: [],
      },
      development: true,
    });

    expect(registry.routes).toEqual([
      { cors, kind: "channel", method: "POST", path: "/hooks/:id" },
      {
        cors: undefined,
        kind: "channel",
        method: "WEBSOCKET",
        path: "/socket/:room",
      },
      { cors: undefined, kind: "channel", method: "GET", path: "/" },
      {
        cors: undefined,
        kind: "channel",
        method: "GET",
        path: "/eve/v1/health",
      },
      {
        cors: undefined,
        kind: "channel",
        method: "HEAD",
        path: "/eve/v1/health",
      },
      { cors, kind: "channel-preflight", method: "OPTIONS", path: "/hooks/:id" },
      {
        hostRouteId: "workflow",
        kind: "host",
        method: "ALL",
        path: "/.well-known/workflow/v1/flow",
      },
      {
        hostRouteId: "development-artifacts",
        kind: "host",
        method: "GET",
        path: "/eve/v1/dev/runtime-artifacts",
      },
      {
        hostRouteId: "development-schedule",
        kind: "host",
        method: "POST",
        path: "/eve/v1/dev/schedules/:scheduleId",
      },
    ]);
  });

  it.each([
    ["development", true, "development-application"],
    ["production", false, "production-application"],
  ] as const)(
    "keeps %s Nitro registrations in parity with the protocol inventory",
    (_, development, mount) => {
      const registry = createApplicationRouteRegistryFromInput({
        channelRoutes: { effective: [], preflight: [], shadowed: [] },
        development,
      });

      expect(registry.routes).toEqual(
        getHostRouteRegistrations(mount).map((route) => ({
          hostRouteId: route.id,
          kind: "host",
          method: route.method,
          path: route.pathPattern,
        })),
      );
    },
  );

  it("keeps ordinary Nitro registrations exactly aligned with agent info channels", () => {
    const cors = { origin: ["https://example.com"] } as const;
    const channels = [
      {
        cors,
        kind: "channel",
        logicalPath: "channels/hooks.ts",
        method: "POST",
        name: "hooks",
        sourceId: "test:channel:hooks",
        sourceKind: "module",
        urlPath: "/hooks/:id",
      },
      {
        kind: "channel",
        logicalPath: "channels/socket.ts",
        method: "WEBSOCKET",
        name: "socket",
        sourceId: "test:channel:socket",
        sourceKind: "module",
        urlPath: "/socket/:room",
      },
    ] satisfies readonly CompiledChannelDefinition[];
    const manifest = createStubCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        ...channels.map(({ logicalPath, sourceId }) => ({ logicalPath, sourceId })),
      ],
      channelRoutes: {
        effective: channels,
        preflight: [{ cors, pathPattern: "/hooks/:id", sourceIds: ["test:channel:hooks"] }],
        shadowed: [],
      },
      config: {
        model: {
          id: "openai/gpt-5.5",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "Route parity",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
    });
    const registry = createApplicationRouteRegistryFromInput({
      channelRoutes: manifest.channelRoutes,
      development: true,
    });
    const agentInfo = buildAgentInfoResponse(
      { manifest },
      {
        gatewayCredentials: { apiKey: false, oidc: false },
        mode: "development",
      },
    );

    expect(registry.routes.some((route) => route.kind === "channel-preflight")).toBe(true);
    expect(registry.routes.some((route) => route.kind === "host")).toBe(true);
    expect(
      registry.routes.flatMap((route) =>
        route.kind === "channel" ? [{ method: route.method, path: route.path }] : [],
      ),
    ).toEqual(agentInfo.channels.map(({ method, urlPath }) => ({ method, path: urlPath })));
  });
});
