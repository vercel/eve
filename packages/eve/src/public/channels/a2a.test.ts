import { describe, expect, it, vi } from "vitest";
import type { RouteHandlerArgs } from "#channel/routes.js";
import {
  attachAgentInfoRouteResponse,
  attachRouteChannelName,
  attachRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import { a2aChannel } from "#public/channels/a2a.js";
import { ForbiddenError, none, withAuthChallenges } from "#public/channels/auth.js";

function args() {
  return attachRouteChannelName(
    attachAgentInfoRouteResponse(
      attachRouteSessionCreator(
        {
          from: vi.fn(),
          params: {},
          attachSession: vi.fn(),
          to: vi.fn(),
          resolveSession: vi.fn(),
          waitUntil: vi.fn(),
          requestIp: "127.0.0.1",
        } satisfies RouteHandlerArgs,
        vi.fn(),
      ),
      async () =>
        Response.json({
          agent: { name: "Travel", description: "Plans trips" },
          skills: [{ secret: "do not publish" }],
        }),
    ),
    "a2a",
  );
}
const security = {
  securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "bearer" } } },
  securityRequirements: [{ schemes: { bearer: { list: [] } } }],
};
describe("a2aChannel", () => {
  it("requires an explicit auth policy and accurate security declarations", () => {
    expect(() => a2aChannel({} as never)).toThrow("requires auth");
    expect(() => a2aChannel({ auth: () => null })).toThrow("securitySchemes");
    expect(() =>
      a2aChannel({ auth: () => null, card: { ...security, securitySchemes: {} } }),
    ).toThrow("Unknown A2A security scheme");
  });
  it("publishes only public metadata with cache validation", async () => {
    const route = a2aChannel({ auth: none(), route: "/agent/rpc" }).routes[0]!;
    if (route.transport === "websocket") throw new Error();
    const response = await route.handler(
      new Request("https://agent.example/.well-known/agent-card.json"),
      args(),
    );
    const card = await response.json();
    expect(card).toMatchObject({
      name: "Travel",
      version: "1.0.0",
      securityRequirements: [],
      supportedInterfaces: [
        {
          url: "https://agent.example/agent/rpc",
          protocolVersion: "1.0",
          protocolBinding: "JSONRPC",
        },
      ],
    });
    expect(JSON.stringify(card)).not.toContain("secret");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(
      (
        await route.handler(
          new Request("https://agent.example/.well-known/agent-card.json", {
            headers: { "if-none-match": response.headers.get("etag")! },
          }),
          args(),
        )
      ).status,
    ).toBe(304);
  });
  it("keeps credential failures at the HTTP boundary", async () => {
    for (const [auth, status] of [
      [withAuthChallenges(() => null, [{ scheme: "Bearer" }]), 401],
      [
        () => {
          throw new ForbiddenError();
        },
        403,
      ],
    ] as const) {
      const route = a2aChannel({ auth, card: security }).routes[1]!;
      if (route.transport === "websocket") throw new Error();
      const response = await route.handler(
        new Request("https://agent.example/eve/v1/a2a", { method: "POST", body: "{}" }),
        args(),
      );
      expect(response.status).toBe(status);
      if (status === 401) expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }
  });
});
