import { describe, expect, it } from "vitest";

import { defineOpenAPIConnection } from "#public/definitions/connections/openapi.js";
import { readConnectionProtocol } from "#public/definitions/connections/protocol.js";

describe("defineOpenAPIConnection", () => {
  it('stamps the "openapi" protocol marker', () => {
    const definition = defineOpenAPIConnection({
      baseUrl: "https://api.example.com",
      description: "test connection",
      spec: "https://api.example.com/openapi.json",
    });

    expect(readConnectionProtocol(definition)).toBe("openapi");
  });

  it('normalizes getToken-only auth to principalType "app"', () => {
    const getToken = async () => ({ token: "test-token" });
    const definition = defineOpenAPIConnection({
      auth: { getToken },
      baseUrl: "https://api.example.com",
      description: "test connection",
      spec: "https://api.example.com/openapi.json",
    });

    expect(definition.auth).toMatchObject({ getToken, principalType: "app" });
  });

  it("preserves context-aware auth resolvers for runtime resolution", () => {
    const definition = defineOpenAPIConnection({
      auth: (ctx) => ({
        getToken: async () => ({ token: ctx.session.id }),
      }),
      baseUrl: "https://api.example.com",
      description: "test connection",
      headers: { "X-User": (ctx) => ctx.session.auth.current?.principalId ?? "anonymous" },
      spec: "https://api.example.com/openapi.json",
    });

    expect(typeof definition.auth).toBe("function");
  });

  it("accepts an inline spec object", () => {
    const spec = { openapi: "3.0.0", paths: {} };
    const definition = defineOpenAPIConnection({
      baseUrl: "https://api.example.com",
      description: "test connection",
      spec,
    });

    expect(definition.spec).toBe(spec);
  });
});
