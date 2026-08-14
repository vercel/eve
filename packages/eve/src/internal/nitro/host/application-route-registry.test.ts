import { describe, expect, it } from "vitest";

import {
  createApplicationRouteRegistryFromInput,
  mergeApplicationChannelRouteRegistrations,
} from "#internal/nitro/host/application-route-registry.js";

describe("mergeApplicationChannelRouteRegistrations", () => {
  it("applies authored overrides, disabled defaults, and framework-first route dedupe", () => {
    const registrations = mergeApplicationChannelRouteRegistrations({
      frameworkChannelNames: new Set(["callback", "eve", "shared"]),
      frameworkChannels: [
        { method: "POST", name: "eve", urlPath: "/framework/session" },
        { method: "POST", name: "callback", urlPath: "/callback" },
        { method: "GET", name: "shared", urlPath: "/duplicate" },
      ],
      manifestChannels: [
        { kind: "disabled", name: "callback" },
        { kind: "channel", method: "POST", name: "eve", urlPath: "/authored/session" },
        { kind: "channel", method: "GET", name: "custom", urlPath: "/duplicate" },
      ],
    });

    expect(registrations).toEqual([
      { cors: undefined, method: "GET", route: "/duplicate" },
      { cors: undefined, method: "POST", route: "/authored/session" },
    ]);
  });

  it("rejects disable files that do not name a framework channel", () => {
    expect(() =>
      mergeApplicationChannelRouteRegistrations({
        frameworkChannelNames: new Set(["eve"]),
        frameworkChannels: [],
        manifestChannels: [{ kind: "disabled", name: "unknown" }],
      }),
    ).toThrow(
      'agent/channels/unknown.ts exports disableRoute() but "unknown" is not a framework channel',
    );
  });
});

describe("createApplicationRouteRegistryFromInput", () => {
  it("centralizes package, channel, development, and workflow precedence", () => {
    const cors = { origin: ["https://example.com"] } as const;
    const registry = createApplicationRouteRegistryFromInput({
      development: true,
      frameworkChannelNames: new Set(),
      frameworkChannels: [],
      manifestChannels: [
        { cors, kind: "channel", method: "POST", name: "hooks", urlPath: "/hooks" },
        { cors, kind: "channel", method: "GET", name: "hooks", urlPath: "/hooks" },
        { cors, kind: "channel", method: "POST", name: "copy", urlPath: "/hooks" },
        {
          cors,
          kind: "channel",
          method: "WEBSOCKET",
          name: "socket",
          urlPath: "/socket/:room",
        },
        {
          kind: "channel",
          method: "GET",
          name: "reserved-health",
          urlPath: "/eve/v1/health",
        },
        {
          kind: "channel",
          method: "GET",
          name: "dev-shadow",
          urlPath: "/eve/v1/dev/runtime-artifacts",
        },
      ],
    });

    expect(registry.channelRegistrations).toEqual([
      { cors, method: "POST", route: "/hooks" },
      { cors, method: "GET", route: "/hooks" },
      { cors, method: "WEBSOCKET", route: "/socket/:room" },
      {
        cors: undefined,
        method: "GET",
        route: "/eve/v1/dev/runtime-artifacts",
      },
    ]);
    expect(registry.routes).toEqual([
      { kind: "home", method: "GET", path: "/" },
      { kind: "health", method: "GET", path: "/eve/v1/health" },
      { kind: "health", method: "HEAD", path: "/eve/v1/health" },
      { cors, kind: "channel", method: "POST", path: "/hooks" },
      { cors, kind: "channel-preflight", method: "OPTIONS", path: "/hooks" },
      { cors, kind: "channel", method: "GET", path: "/hooks" },
      {
        cors,
        kind: "channel",
        method: "WEBSOCKET",
        path: "/socket/:room",
      },
      {
        cors: undefined,
        kind: "channel",
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
  });

  it("omits development routes outside development", () => {
    const registry = createApplicationRouteRegistryFromInput({
      frameworkChannelNames: new Set(),
      frameworkChannels: [],
      manifestChannels: [],
    });

    expect(registry.routes.map((route) => route.kind)).toEqual([
      "home",
      "health",
      "health",
      "workflow",
    ]);
  });
});
