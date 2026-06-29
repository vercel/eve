import { describe, expect, it } from "vitest";

import { normalizeOpenApiConnectionDefinition } from "#internal/authored-definition/connection.js";

const MSG = "Expected the connection export to match the public eve shape.";

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: "https://api.example.com",
    description: "A test OpenAPI connection.",
    spec: "https://api.example.com/openapi.json",
    ...overrides,
  };
}

describe("normalizeOpenApiConnectionDefinition", () => {
  describe("happy path", () => {
    it("accepts a string spec URL and base URL", () => {
      const result = normalizeOpenApiConnectionDefinition(validInput(), MSG);

      expect(result.spec).toBe("https://api.example.com/openapi.json");
      expect(result.baseUrl).toBe("https://api.example.com");
      expect(result.description).toBe("A test OpenAPI connection.");
    });

    it("accepts an inline spec object", () => {
      const spec = { openapi: "3.0.0", paths: {} };
      const result = normalizeOpenApiConnectionDefinition(validInput({ spec }), MSG);

      expect(result.spec).toEqual(spec);
    });

    it("normalizes an operations allow filter", () => {
      const result = normalizeOpenApiConnectionDefinition(
        validInput({ operations: { allow: ["getProjects"] } }),
        MSG,
      );

      expect(result.operations).toEqual({ allow: ["getProjects"] });
    });

    it('defaults getToken-only auth to principalType "app"', () => {
      const getToken = async () => ({ token: "x" });
      const result = normalizeOpenApiConnectionDefinition(validInput({ auth: { getToken } }), MSG);

      expect(result.auth).toMatchObject({ principalType: "app" });
    });

    it("preserves a context-aware auth resolver without invoking it at build time", () => {
      let calls = 0;
      const auth = () => {
        calls += 1;
        return { getToken: async () => ({ token: "x" }) };
      };
      const result = normalizeOpenApiConnectionDefinition(validInput({ auth }), MSG);

      expect(result.auth).toBe(auth);
      expect(calls).toBe(0);
    });
  });

  describe("validation", () => {
    it("accepts an omitted baseUrl (falls back to the spec servers at runtime)", () => {
      const result = normalizeOpenApiConnectionDefinition(validInput({ baseUrl: undefined }), MSG);

      expect(result.baseUrl).toBeUndefined();
    });

    it("rejects an invalid baseUrl when provided", () => {
      expect(() =>
        normalizeOpenApiConnectionDefinition(validInput({ baseUrl: "not a url" }), MSG),
      ).toThrow(/baseUrl/);
    });

    it("rejects a non-URL string spec", () => {
      expect(() =>
        normalizeOpenApiConnectionDefinition(validInput({ spec: "not a url" }), MSG),
      ).toThrow(/spec/);
    });

    it("rejects an unknown top-level key", () => {
      expect(() =>
        normalizeOpenApiConnectionDefinition(validInput({ url: "https://x.com" }), MSG),
      ).toThrow();
    });

    it("rejects operations specifying both allow and block", () => {
      expect(() =>
        normalizeOpenApiConnectionDefinition(
          validInput({ operations: { allow: ["a"], block: ["b"] } }),
          MSG,
        ),
      ).toThrow(/allow.*block|block.*allow/);
    });
  });
});
