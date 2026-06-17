import { describe, expect, it } from "vitest";

import { normalizeMcpClientConnectionDefinition } from "#internal/authored-definition/connection.js";

const MSG = "Expected the connection export to match the public eve shape.";

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      getToken: async () => ({ token: "test-token" }),
      principalType: "app",
    },
    description: "A test connection.",
    url: "https://mcp.example.com/sse",
    ...overrides,
  };
}

describe("normalizeMcpClientConnectionDefinition", () => {
  describe("happy path", () => {
    it("accepts a valid definition with a getToken function", () => {
      const result = normalizeMcpClientConnectionDefinition(validInput(), MSG);

      expect(result.url).toBe("https://mcp.example.com/sse");
      expect(result.description).toBe("A test connection.");
      expect(typeof result.auth?.getToken).toBe("function");
    });

    it("preserves the author's getToken reference", () => {
      const getToken = async () => ({ token: "x" });
      const result = normalizeMcpClientConnectionDefinition(
        validInput({ auth: { getToken, principalType: "app" } }),
        MSG,
      );

      expect(result.auth?.getToken).toBe(getToken);
    });

    it('defaults getToken-only auth to principalType "app"', () => {
      const getToken = async () => ({ token: "x" });
      const result = normalizeMcpClientConnectionDefinition(
        validInput({ auth: { getToken } }),
        MSG,
      );

      expect(result.auth).toMatchObject({ getToken, principalType: "app" });
    });

    it("accepts the full three-method interactive-OAuth shape", () => {
      const getToken = async () => ({ token: "cached" });
      const startAuthorization = async () => ({
        challenge: { url: "https://idp.example/auth" },
        state: { authorizationId: "abc" },
      });
      const completeAuthorization = async () => ({ token: "fresh" });
      const result = normalizeMcpClientConnectionDefinition(
        validInput({
          auth: {
            completeAuthorization,
            getToken,
            principalType: "user",
            startAuthorization,
          },
        }),
        MSG,
      );

      expect(result.auth?.getToken).toBe(getToken);
      expect(result.auth?.startAuthorization).toBe(startAuthorization);
      expect(result.auth?.completeAuthorization).toBe(completeAuthorization);
    });

    it("accepts an http URL", () => {
      const result = normalizeMcpClientConnectionDefinition(
        validInput({ url: "http://localhost:3000/mcp" }),
        MSG,
      );

      expect(result.url).toBe("http://localhost:3000/mcp");
    });

    it("preserves the optional vercelConnect marker on auth", () => {
      // The `connect()` helper from `@vercel/connect/eve` attaches a
      // `vercelConnect: { connector }` marker so downstream tooling can
      // detect Vercel Connect-backed connections without inspecting the
      // closure state of `getToken`. Validation must let it through and
      // the normalized result must preserve it.
      const result = normalizeMcpClientConnectionDefinition(
        validInput({
          auth: {
            getToken: async () => ({ token: "x" }),
            principalType: "app",
            vercelConnect: { connector: "oauth/mcp-linear-app" },
          },
        }),
        MSG,
      );

      expect((result.auth as Record<string, unknown>).vercelConnect).toEqual({
        connector: "oauth/mcp-linear-app",
      });
    });

    it("drops a malformed vercelConnect marker without throwing", () => {
      // A misbehaving auth provider could attach a malformed marker; the
      // normalizer treats it as absent rather than failing the whole
      // connection. This protects against auth providers we don't control.
      const result = normalizeMcpClientConnectionDefinition(
        validInput({
          auth: {
            getToken: async () => ({ token: "x" }),
            principalType: "app",
            vercelConnect: { connector: "" },
          },
        }),
        MSG,
      );

      expect((result.auth as Record<string, unknown>).vercelConnect).toBeUndefined();
    });
  });

  describe("url validation", () => {
    it("rejects a non-string url", () => {
      expect(() => normalizeMcpClientConnectionDefinition(validInput({ url: 42 }), MSG)).toThrow(
        /must be a valid URL/,
      );
    });

    it("rejects an unparseable url", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(validInput({ url: "not a url" }), MSG),
      ).toThrow(/must be a valid URL/);
    });

    it("rejects a non-http/https protocol", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(validInput({ url: "ftp://example.com" }), MSG),
      ).toThrow(/must use the http or https protocol/);
    });
  });

  describe("description validation", () => {
    it("rejects a non-string description", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(validInput({ description: 123 }), MSG),
      ).toThrow(/must be a non-empty string/);
    });

    it("rejects an empty description", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(validInput({ description: "" }), MSG),
      ).toThrow(/must be a non-empty string/);
    });
  });

  describe("auth validation", () => {
    it("accepts missing auth when headers are present", () => {
      const result = normalizeMcpClientConnectionDefinition(
        {
          description: "test",
          headers: { "X-Api-Key": "key123" },
          url: "https://example.com",
        },
        MSG,
      );

      expect(result.auth).toBeUndefined();
      expect(result.headers).toBeDefined();
    });

    it("accepts when both auth and headers are omitted", () => {
      const result = normalizeMcpClientConnectionDefinition(
        { description: "test", url: "https://example.com" },
        MSG,
      );

      expect(result.auth).toBeUndefined();
      expect(result.headers).toBeUndefined();
    });

    it("rejects auth without getToken", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(validInput({ auth: { principalType: "app" } }), MSG),
      ).toThrow(/auth\.getToken/i);
    });

    it("rejects a non-function getToken", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(
          validInput({ auth: { getToken: "not a function", principalType: "app" } }),
          MSG,
        ),
      ).toThrow(/auth\.getToken.*must be a function/i);
    });

    it("accepts getToken-only auth without principalType", () => {
      const result = normalizeMcpClientConnectionDefinition(
        validInput({ auth: { getToken: async () => ({ token: "x" }) } }),
        MSG,
      );

      expect(result.auth).toMatchObject({ principalType: "app" });
    });

    it("rejects an invalid principalType", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(
          validInput({ auth: { getToken: async () => ({ token: "x" }), principalType: "bot" } }),
          MSG,
        ),
      ).toThrow(/"auth\.principalType" field must be "app" or "user"/);
    });

    it('rejects interactive auth with principalType "app"', () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(
          validInput({
            auth: {
              completeAuthorization: async () => ({ token: "x" }),
              getToken: async () => ({ token: "x" }),
              principalType: "app",
              startAuthorization: async () => ({ challenge: {}, state: {} }),
            },
          }),
          MSG,
        ),
      ).toThrow(/Interactive authorization.*restricted to "principalType": "user"/);
    });

    it("rejects startAuthorization without completeAuthorization", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(
          validInput({
            auth: {
              getToken: async () => ({ token: "x" }),
              principalType: "user",
              startAuthorization: async () => ({ challenge: {}, state: {} }),
            },
          }),
          MSG,
        ),
      ).toThrow(/both "startAuthorization" and "completeAuthorization"/);
    });

    it("rejects completeAuthorization without startAuthorization", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(
          validInput({
            auth: {
              completeAuthorization: async () => ({ token: "x" }),
              getToken: async () => ({ token: "x" }),
              principalType: "user",
            },
          }),
          MSG,
        ),
      ).toThrow(/both "startAuthorization" and "completeAuthorization"/);
    });

    it("rejects unknown keys in auth", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(
          validInput({
            auth: {
              extra: true,
              getToken: async () => ({ token: "x" }),
              principalType: "app",
            },
          }),
          MSG,
        ),
      ).toThrow(/unknown/i);
    });
  });

  describe("approval validation", () => {
    it("accepts a valid definition without approval", () => {
      const result = normalizeMcpClientConnectionDefinition(validInput(), MSG);
      expect(result.approval).toBeUndefined();
    });

    it("accepts a function approval", () => {
      const fn = () => false;
      const result = normalizeMcpClientConnectionDefinition(validInput({ approval: fn }), MSG);
      expect(result.approval).toBe(fn);
    });

    it("rejects a non-function approval", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(validInput({ approval: "never" }), MSG),
      ).toThrow(/must be a function/);
    });

    it("rejects a boolean approval", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(validInput({ approval: true }), MSG),
      ).toThrow(/must be a function/);
    });
  });

  describe("headers validation", () => {
    it("accepts a static headers object", () => {
      const result = normalizeMcpClientConnectionDefinition(
        validInput({ headers: { "X-Custom": "value" } }),
        MSG,
      );

      expect(result.headers).toEqual({ "X-Custom": "value" });
    });

    it("accepts a function-form headers", () => {
      const fn = () => ({ "X-Key": "val" });
      const result = normalizeMcpClientConnectionDefinition(validInput({ headers: fn }), MSG);

      expect(result.headers).toBe(fn);
    });

    it("accepts headers with function values", () => {
      const fn = () => "dynamic";
      const result = normalizeMcpClientConnectionDefinition(
        validInput({ headers: { "X-Key": fn } }),
        MSG,
      );

      const headers = result.headers as Record<string, unknown>;
      expect(headers["X-Key"]).toBe(fn);
    });

    it("accepts headers with Promise values", () => {
      const p = Promise.resolve("async-val");
      const result = normalizeMcpClientConnectionDefinition(
        validInput({ headers: { "X-Key": p } }),
        MSG,
      );

      const headers = result.headers as Record<string, unknown>;
      expect(headers["X-Key"]).toBe(p);
    });

    it("accepts headers-only (no auth)", () => {
      const result = normalizeMcpClientConnectionDefinition(
        {
          description: "test",
          headers: { "DD-API-KEY": "abc", "DD-APPLICATION-KEY": "def" },
          url: "https://mcp.example.com",
        },
        MSG,
      );

      expect(result.auth).toBeUndefined();
      expect(result.headers).toEqual({
        "DD-API-KEY": "abc",
        "DD-APPLICATION-KEY": "def",
      });
    });

    it("rejects a non-object, non-function headers", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(validInput({ headers: "bad" }), MSG),
      ).toThrow(/must be a plain object or a function/);
    });

    it("rejects a headers value that is not string/Promise/function", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(validInput({ headers: { "X-Key": 42 } }), MSG),
      ).toThrow(/headers\.X-Key.*must be a string, Promise, or function/);
    });

    it("rejects a null header value", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(validInput({ headers: { "X-Key": null } }), MSG),
      ).toThrow(/headers\.X-Key.*must be a string, Promise, or function/);
    });

    it("rejects Authorization header when auth is also present", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(
          validInput({ headers: { Authorization: "Bearer x" } }),
          MSG,
        ),
      ).toThrow(/must not include an "Authorization" key when "auth" is also provided/);
    });

    it("rejects authorization header (case-insensitive)", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(
          validInput({ headers: { authorization: "Bearer x" } }),
          MSG,
        ),
      ).toThrow(/must not include an "Authorization" key/);
    });

    it("allows Authorization header when auth is absent", () => {
      const result = normalizeMcpClientConnectionDefinition(
        {
          description: "test",
          headers: { Authorization: "Custom scheme" },
          url: "https://example.com",
        },
        MSG,
      );

      expect(result.auth).toBeUndefined();
      const headers = result.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Custom scheme");
    });
  });

  describe("tools (tool filter) validation", () => {
    it("accepts an allow filter", () => {
      const result = normalizeMcpClientConnectionDefinition(
        validInput({ tools: { allow: ["tool_a", "tool_b"] } }),
        MSG,
      );

      expect(result.tools).toEqual({ allow: ["tool_a", "tool_b"] });
    });

    it("accepts a block filter", () => {
      const result = normalizeMcpClientConnectionDefinition(
        validInput({ tools: { block: ["tool_c"] } }),
        MSG,
      );

      expect(result.tools).toEqual({ block: ["tool_c"] });
    });

    it("rejects specifying both allow and block", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(
          validInput({ tools: { allow: ["a"], block: ["b"] } }),
          MSG,
        ),
      ).toThrow(/either "allow" or "block", not both/);
    });

    it("rejects tools with neither allow nor block", () => {
      expect(() => normalizeMcpClientConnectionDefinition(validInput({ tools: {} }), MSG)).toThrow(
        /must specify either "allow" or "block"/,
      );
    });

    it("rejects allow that is not an array", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(validInput({ tools: { allow: "not-array" } }), MSG),
      ).toThrow(/must be an array of strings/);
    });

    it("rejects allow with non-string elements", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(validInput({ tools: { allow: [42] } }), MSG),
      ).toThrow(/must be a string/);
    });

    it("rejects a non-object tools value", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(validInput({ tools: "bad" }), MSG),
      ).toThrow(/must specify either "allow" or "block"/);
    });

    it("omits tools from result when not specified", () => {
      const result = normalizeMcpClientConnectionDefinition(validInput(), MSG);
      expect(result.tools).toBeUndefined();
    });
  });

  describe("top-level shape", () => {
    it("rejects non-object input", () => {
      expect(() => normalizeMcpClientConnectionDefinition("not an object", MSG)).toThrow();
    });

    it("rejects null input", () => {
      expect(() => normalizeMcpClientConnectionDefinition(null, MSG)).toThrow();
    });

    it("rejects unknown top-level keys", () => {
      expect(() =>
        normalizeMcpClientConnectionDefinition(validInput({ extra: "field" }), MSG),
      ).toThrow(/unknown/i);
    });
  });
});
