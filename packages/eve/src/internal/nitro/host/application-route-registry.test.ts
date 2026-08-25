import { describe, expect, it } from "vitest";

import type {
  CompiledChannelDefinition,
  CompiledChannelPreflightDefinition,
} from "#compiler/manifest.js";
import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import {
  createApplicationRouteRegistry,
  createApplicationRouteRegistryFromInput,
} from "#internal/nitro/host/application-route-registry.js";

function channelRoute(input: {
  readonly cors?: NormalizedChannelCorsOptions;
  readonly method: CompiledChannelDefinition["method"];
  readonly name: string;
  readonly urlPath: string;
}): CompiledChannelDefinition {
  return {
    ...(input.cors !== undefined && { cors: input.cors }),
    kind: "channel",
    logicalPath: `channels/${input.name}.ts`,
    method: input.method,
    name: input.name,
    sourceId: `channels/${input.name}.ts`,
    sourceKind: "module",
    urlPath: input.urlPath,
  };
}

function preflight(input: {
  readonly cors: NormalizedChannelCorsOptions;
  readonly sourceIds: readonly string[];
  readonly urlPath: string;
}): CompiledChannelPreflightDefinition {
  return input;
}

describe("createApplicationRouteRegistryFromInput", () => {
  it("projects effective routes in plan order, then preflights, dev routes, and the workflow route", () => {
    const cors = { origin: ["https://example.com"] } as const;
    const registry = createApplicationRouteRegistryFromInput({
      channelRoutePlan: {
        effective: [
          channelRoute({ cors, method: "POST", name: "hooks", urlPath: "/hooks" }),
          channelRoute({ cors, method: "GET", name: "hooks", urlPath: "/hooks" }),
          channelRoute({ cors, method: "WEBSOCKET", name: "socket", urlPath: "/socket/:room" }),
          channelRoute({ method: "GET", name: "home", urlPath: "/" }),
        ],
        preflight: [preflight({ cors, sourceIds: ["channels/hooks.ts"], urlPath: "/hooks" })],
        shadowed: [],
      },
      development: true,
    });

    expect(registry.channelRegistrations).toEqual([
      { cors, method: "POST", route: "/hooks" },
      { cors, method: "GET", route: "/hooks" },
      { cors, method: "WEBSOCKET", route: "/socket/:room" },
      { cors: undefined, method: "GET", route: "/" },
    ]);
    expect(registry.routes).toEqual([
      { cors, kind: "channel", method: "POST", path: "/hooks" },
      { cors, kind: "channel", method: "GET", path: "/hooks" },
      { cors, kind: "channel", method: "WEBSOCKET", path: "/socket/:room" },
      { cors: undefined, kind: "channel", method: "GET", path: "/" },
      { cors, kind: "channel-preflight", method: "OPTIONS", path: "/hooks" },
      {
        kind: "development-artifacts",
        method: "GET",
        path: "/eve/v1/dev/runtime-artifacts",
      },
      {
        kind: "development-schedule",
        method: "POST",
        path: "/eve/v1/dev/schedules/:scheduleId",
      },
      {
        kind: "workflow",
        method: "ALL",
        path: "/.well-known/workflow/v1/flow",
      },
    ]);
    expect(registry.channelRoutes).toEqual(
      registry.routes.filter(
        (route) => route.kind === "channel" || route.kind === "channel-preflight",
      ),
    );
  });

  it("performs no second merge: identical plan entries are mounted verbatim", () => {
    const registry = createApplicationRouteRegistryFromInput({
      channelRoutePlan: {
        effective: [
          channelRoute({ method: "GET", name: "first", urlPath: "/duplicate" }),
          channelRoute({ method: "GET", name: "second", urlPath: "/duplicate" }),
        ],
        preflight: [],
        shadowed: [],
      },
    });

    expect(registry.channelRegistrations).toEqual([
      { cors: undefined, method: "GET", route: "/duplicate" },
      { cors: undefined, method: "GET", route: "/duplicate" },
    ]);
  });

  it("omits development routes outside development", () => {
    const registry = createApplicationRouteRegistryFromInput({
      channelRoutePlan: {
        effective: [channelRoute({ method: "GET", name: "home", urlPath: "/" })],
        preflight: [],
        shadowed: [],
      },
    });

    expect(registry.routes.map((route) => route.kind)).toEqual(["channel", "workflow"]);
  });
});

describe("createApplicationRouteRegistry", () => {
  it("reads the compiled channel route plan from the prepared host manifest", () => {
    const preparedHost = {
      compileResult: {
        manifest: {
          channelRoutes: {
            effective: [channelRoute({ method: "GET", name: "health", urlPath: "/eve/v1/health" })],
            preflight: [],
            shadowed: [],
          },
        },
      },
    };

    const registry = createApplicationRouteRegistry(preparedHost, { development: true });

    expect(registry.routes.map((route) => route.kind)).toEqual([
      "channel",
      "development-artifacts",
      "development-schedule",
      "workflow",
    ]);
    expect(registry.channelRegistrations).toEqual([
      { cors: undefined, method: "GET", route: "/eve/v1/health" },
    ]);
  });
});
