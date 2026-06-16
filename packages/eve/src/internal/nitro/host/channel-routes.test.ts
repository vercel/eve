import { describe, expect, it } from "vitest";

import { registerChannelVirtualHandlers } from "#internal/nitro/host/channel-routes.js";

describe("registerChannelVirtualHandlers", () => {
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
