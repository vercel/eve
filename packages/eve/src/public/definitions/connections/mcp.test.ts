import { describe, expect, it } from "vitest";

import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";

describe("defineMcpClientConnection", () => {
  it('normalizes getToken-only auth to principalType "app"', () => {
    const getToken = async () => ({ token: "test-token" });
    const definition = defineMcpClientConnection({
      auth: { getToken },
      description: "test connection",
      url: "https://mcp.example.com",
    });

    expect(definition.auth).toMatchObject({ getToken, principalType: "app" });
  });
});
