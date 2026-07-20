import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { mcpChannel } from "#public/channels/mcp.js";

const auth: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

describe("mcpChannel", () => {
  const channel = mcpChannel({
    agent: { description: "Investigates tasks." },
    auth: async (request) => (request.headers.has("authorization") ? auth : null),
    oauth: {
      authorizationServers: ["https://issuer.example"],
      resource: "https://agent.example/mcp",
    },
  });

  it("registers the endpoint and protected-resource metadata", async () => {
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /.well-known/oauth-protected-resource",
      "POST /mcp",
      "DELETE /mcp",
    ]);
    const route = channel.routes[0]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      new Request("https://agent.example/.well-known/oauth-protected-resource"),
      {} as never,
    );
    expect(await response.json()).toEqual({
      authorization_servers: ["https://issuer.example"],
      resource: "https://agent.example/mcp",
    });
  });

  it("returns an MCP OAuth discovery challenge before runtime lookup", async () => {
    const route = channel.routes[1]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      new Request("https://agent.example/mcp", {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize" }),
        method: "POST",
      }),
      {} as never,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://agent.example/.well-known/oauth-protected-resource"',
    );
  });
});
