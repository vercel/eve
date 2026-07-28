import { describe, expect, it } from "vitest";

import { createDevelopmentNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import {
  describeChannelNitroRouteResources,
  registerChannelVirtualHandlers,
  replaceLiveChannelVirtualHandlers,
} from "#internal/nitro/host/channel-routes.js";

describe("describeChannelNitroRouteResources", () => {
  it("describes the exact handler and virtual resources registration will own", () => {
    expect(
      describeChannelNitroRouteResources([
        { cors: {}, method: "GET", route: "/events" },
        { cors: {}, method: "POST", route: "/events" },
        { method: "WEBSOCKET", route: "/voice" },
      ]),
    ).toEqual([
      {
        method: "GET",
        route: "/events",
        virtualId: "#nitro/virtual/eve-channel/GET /events",
      },
      {
        method: "OPTIONS",
        route: "/events",
        virtualId: "#nitro/virtual/eve-channel/OPTIONS /events",
      },
      {
        method: "POST",
        route: "/events",
        virtualId: "#nitro/virtual/eve-channel/POST /events",
      },
      {
        route: "/voice",
        virtualId: "#nitro/virtual/eve-channel/WEBSOCKET /voice",
      },
    ]);
  });
});

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

describe("replaceLiveChannelVirtualHandlers", () => {
  it("updates Nitro options and its initialized virtual file system", async () => {
    const oldVirtualId = "#nitro/virtual/eve-channel/GET /old";
    const nitro = {
      options: {
        handlers: [{ handler: oldVirtualId, method: "GET" as const, route: "/old" }],
        virtual: { [oldVirtualId]: "export default () => 'old';" } as Record<
          string,
          string | (() => string | Promise<string>)
        >,
      },
      vfs: new Map([[oldVirtualId, { render: () => "export default () => 'old';" }]]),
    };

    replaceLiveChannelVirtualHandlers(nitro, {
      artifactsConfig: createDevelopmentNitroArtifactsConfig({ appRoot: "/app" }),
      next: [{ method: "POST", route: "/new" }],
      previous: [{ method: "GET", route: "/old" }],
    });

    const newVirtualId = "#nitro/virtual/eve-channel/POST /new";
    expect(nitro.options.handlers).toEqual([
      { handler: newVirtualId, method: "POST", route: "/new" },
    ]);
    expect(nitro.options.virtual[oldVirtualId]).toBeUndefined();
    expect(nitro.vfs.has(oldVirtualId)).toBe(false);
    expect(await nitro.vfs.get(newVirtualId)?.render()).toContain("dispatchChannelRequest");
  });
});
