import { describe, expect, it } from "vitest";

import { registerChannelVirtualHandlers } from "#internal/nitro/host/channel-routes.js";

describe("registerChannelVirtualHandlers", () => {
  it("wraps CORS-enabled HTTP routes and registers preflight handlers", () => {
    const nitro = {
      options: {
        handlers: [] as any[],
        virtual: {} as Record<string, string>,
      },
    };

    registerChannelVirtualHandlers(nitro, {
      artifactsConfig: { appRoot: "/app", dev: true },
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
      artifactsConfig: { appRoot: "/app", dev: true },
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
      artifactsConfig: { appRoot: "/app", dev: true },
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
