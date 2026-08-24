import { describe, expect, it } from "vitest";

import { createDevelopmentNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import { registerChannelVirtualHandlers } from "#internal/nitro/host/channel-routes.js";

const localWorldPlan = {
  kind: "native",
  selection: "host-default",
  target: "local",
} as const;

describe("registerChannelVirtualHandlers", () => {
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
        worldPlan: localWorldPlan,
      }),
      routes: [
        { cors: {}, kind: "channel", method: "POST", path: "/eve/v1/session" },
        {
          cors: {},
          kind: "channel-preflight",
          method: "OPTIONS",
          path: "/eve/v1/session",
        },
      ],
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
        worldPlan: localWorldPlan,
      }),
      routes: [
        {
          cors: {},
          kind: "channel",
          method: "GET",
          path: "/eve/v1/session/:sessionId/events",
        },
        {
          cors: {},
          kind: "channel-preflight",
          method: "OPTIONS",
          path: "/eve/v1/session/:sessionId/events",
        },
        {
          cors: {},
          kind: "channel",
          method: "POST",
          path: "/eve/v1/session/:sessionId/events",
        },
      ],
    });

    expect(
      nitro.options.handlers.filter(
        (handler) =>
          handler.method === "OPTIONS" && handler.route === "/eve/v1/session/:sessionId/events",
      ),
    ).toHaveLength(1);
  });

  it("lets an authored CORS-enabled OPTIONS handler own its response", () => {
    const nitro = {
      options: {
        handlers: [] as any[],
        virtual: {} as Record<string, string>,
      },
    };

    registerChannelVirtualHandlers(nitro, {
      artifactsConfig: createDevelopmentNitroArtifactsConfig({
        appRoot: "/app",
        worldPlan: localWorldPlan,
      }),
      routes: [{ cors: {}, kind: "channel", method: "OPTIONS", path: "/custom-options" }],
    });

    const source = nitro.options.virtual["#nitro/virtual/eve-channel/OPTIONS /custom-options"];
    expect(source).toContain("dispatchChannelRequest");
    expect(source).toContain("appendCorsPreflightHeaders");
    expect(source).toContain("appendCorsHeaders");
    expect(source).toContain("isPreflightRequest");
    expect(source).not.toContain("handleCors");
    expect(source).not.toContain("return new Response(null, { status: 204 })");
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
        worldPlan: localWorldPlan,
      }),
      routes: [{ kind: "channel", method: "WEBSOCKET", path: "/voice" }],
    });

    expect(nitro.options.handlers).toEqual([
      {
        handler: "#nitro/virtual/eve-channel/WEBSOCKET /voice",
        method: "GET",
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
