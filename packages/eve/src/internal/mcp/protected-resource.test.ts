import { describe, expect, it } from "vitest";

import {
  createMcpProtectedResourceMetadata,
  createMcpResourceChallenge,
} from "#internal/mcp/protected-resource.js";

describe("MCP protected-resource authentication", () => {
  it("builds RFC 9728 metadata", () => {
    expect(
      createMcpProtectedResourceMetadata({
        authorizationServers: ["https://issuer.example"],
        resource: "https://agent.example/mcp",
        scopesSupported: ["agent:invoke"],
      }),
    ).toEqual({
      authorization_servers: ["https://issuer.example"],
      resource: "https://agent.example/mcp",
      scopes_supported: ["agent:invoke"],
    });
  });

  it("challenges with the metadata URL", () => {
    expect(
      createMcpResourceChallenge("https://agent.example/.well-known/oauth-protected-resource", [
        "agent:invoke",
      ]),
    ).toBe(
      'Bearer resource_metadata="https://agent.example/.well-known/oauth-protected-resource", scope="agent:invoke"',
    );
  });
});
