import { describe, expect, it } from "vitest";

import type { CompiledReceiveOnlyChannelDefinition } from "#compiler/manifest.js";
import { createDevelopmentNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import {
  computeChannelRouteRegistrations,
  registerChannelVirtualHandlers,
} from "#internal/nitro/host/channel-routes.js";

describe("registerChannelVirtualHandlers", () => {
  it("does not mount a route for a receive-only channel", () => {
    const receiveOnlyChannel = {
      adapterKind: "http",
      kind: "receive-only-channel",
      logicalPath: "channels/learning.ts",
      name: "learning",
      sourceId: "channels/learning.ts",
      sourceKind: "module",
    } satisfies CompiledReceiveOnlyChannelDefinition;
    const withoutAuthoredChannels = {
      compileResult: { manifest: { channels: [] } },
    };
    const withReceiveOnlyChannel = {
      compileResult: { manifest: { channels: [receiveOnlyChannel] } },
    };

    expect(computeChannelRouteRegistrations(withReceiveOnlyChannel)).toEqual(
      computeChannelRouteRegistrations(withoutAuthoredChannels),
    );
  });

  it("wraps CORS-enabled HTTP routes and registers preflight handlers", () => {
    const nitro = {
      options: {
        handlers: [] as any[],
        virtual: {} as Record<string, string>,
      },
    };

    registerChannelVirtualHandlers(nitro, {
      artifactsConfig: createDevelopmentNitroArtifactsConfig({
        appRoot: "/app",
      }),
      registrations: [{ cors: {}, method: "POST", route: "/eve/v1/session" }],
    });

    expect(nitro.options.handlers).toEqual([
      {
        handler: "#nitro/virtual/eve-channel/POST /eve/v1/session",
        method: "POST",
        route: "/eve/v1/session",
      },
      {
        handler: "#nitro/virtual/eve-channel/OPTIONS /eve/v1/session",
        method: "OPTIONS",
        route: "/eve/v1/session",
      },
    ]);
    expect(nitro.options.virtual["#nitro/virtual/eve-channel/POST /eve/v1/session"]).toContain(
      "handleCors",
    );
    expect(nitro.options.virtual["#nitro/virtual/eve-channel/POST /eve/v1/session"]).toContain(
      "dispatchChannelRequest",
    );
    expect(nitro.options.virtual["#nitro/virtual/eve-channel/OPTIONS /eve/v1/session"]).toContain(
      "return new Response(null, { status: 204 });",
    );
  });

  it("registers one preflight handler per CORS-enabled path", () => {
    const nitro = {
      options: {
        handlers: [] as any[],
        virtual: {} as Record<string, string>,
      },
    };

    registerChannelVirtualHandlers(nitro, {
      artifactsConfig: createDevelopmentNitroArtifactsConfig({
        appRoot: "/app",
      }),
      registrations: [
        { cors: {}, method: "GET", route: "/eve/v1/session/:sessionId/events" },
        { cors: {}, method: "POST", route: "/eve/v1/session/:sessionId/events" },
      ],
    });

    expect(
      nitro.options.handlers.filter(
        (handler) =>
          handler.method === "OPTIONS" && handler.route === "/eve/v1/session/:sessionId/events",
      ),
    ).toHaveLength(1);
  });

  it("registers websocket routes with the websocket dispatcher", () => {
    const nitro = {
      options: {
        handlers: [] as any[],
        virtual: {} as Record<string, string>,
      },
    };

    registerChannelVirtualHandlers(nitro, {
      artifactsConfig: createDevelopmentNitroArtifactsConfig({
        appRoot: "/app",
      }),
      registrations: [{ method: "WEBSOCKET", route: "/voice" }],
    });

    expect(nitro.options.handlers).toEqual([
      {
        handler: "#nitro/virtual/eve-channel/WEBSOCKET /voice",
        route: "/voice",
      },
    ]);
    expect(nitro.options.virtual["#nitro/virtual/eve-channel/WEBSOCKET /voice"]).toContain(
      "defineWebSocketHandler",
    );
    expect(nitro.options.virtual["#nitro/virtual/eve-channel/WEBSOCKET /voice"]).not.toContain(
      'from "nitro"',
    );
    expect(nitro.options.virtual["#nitro/virtual/eve-channel/WEBSOCKET /voice"]).toContain(
      "dispatchChannelWebSocketRequest",
    );
  });
});
