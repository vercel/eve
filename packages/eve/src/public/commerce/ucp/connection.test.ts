import { describe, expect, it } from "vitest";

import { defineUcpConnection } from "#public/commerce/ucp/connection.js";
import { UCP_VERSION } from "#public/commerce/ucp/protocol.js";
import { normalizeOpenApiConnectionDefinition } from "#internal/authored-definition/connection.js";
import { readConnectionProtocol } from "#public/definitions/connections/protocol.js";
import type { SessionContext } from "#public/definitions/callback-context.js";

const AGENT = { profile: "https://agent.example/.well-known/ucp" } as const;

function sessionContext(id: string): SessionContext {
  return {
    getSandbox: () => Promise.reject(new Error("no sandbox in this test")),
    getSkill: () => {
      throw new Error("no skills in this test");
    },
    session: {
      auth: { current: null, initiator: null },
      id,
      turn: { id: "turn-1", sequence: 0 },
    },
  };
}

function define(overrides: Record<string, unknown> = {}) {
  return defineUcpConnection({
    agent: AGENT,
    description: "Acme storefront.",
    endpoint: "https://acme.example.com/ucp/v1",
    ...overrides,
  });
}

describe("defineUcpConnection", () => {
  it("produces an OpenAPI connection against the merchant endpoint", () => {
    const connection = define();
    expect(readConnectionProtocol(connection)).toBe("openapi");
    expect(connection.baseUrl).toBe("https://acme.example.com/ucp/v1");
    expect(connection.spec).toBe(
      `https://ucp.dev/${UCP_VERSION}/services/shopping/rest.openapi.json`,
    );
  });

  it("loads the contract for an older protocol version", () => {
    expect(define({ version: "2026-01-11" }).spec).toBe(
      "https://ucp.dev/2026-01-11/services/shopping/rest.openapi.json",
    );
  });

  it("accepts a merchant-published contract override", () => {
    const spec = { openapi: "3.1.0", paths: {} };
    expect(define({ spec }).spec).toBe(spec);
  });

  it("advertises the agent profile on every request", () => {
    expect(define().headers).toMatchObject({
      "UCP-Agent": 'profile="https://agent.example/.well-known/ucp"',
    });
  });

  it("merges authored static headers after its own", () => {
    expect(define({ headers: { "X-Tenant": "acme" } }).headers).toMatchObject({
      "UCP-Agent": 'profile="https://agent.example/.well-known/ucp"',
      "X-Tenant": "acme",
    });
  });

  it("composes with an authored header resolver", async () => {
    const headers = define({
      headers: (ctx: SessionContext) => ({ "X-Session": ctx.session.id }),
    }).headers;
    if (typeof headers !== "function") {
      throw new Error("expected a header resolver");
    }
    await expect(headers(sessionContext("s_1"))).resolves.toEqual({
      "UCP-Agent": 'profile="https://agent.example/.well-known/ucp"',
      "X-Session": "s_1",
    });
  });

  it("takes protocol header parameters away from the model", () => {
    const provided = define().toolCall?.providedArguments ?? {};
    for (const name of [
      "Authorization",
      "Content-Digest",
      "Idempotency-Key",
      "Request-Id",
      "Signature",
      "Signature-Input",
      "UCP-Agent",
      "X-API-Key",
    ]) {
      expect(provided).toHaveProperty(name, null);
      expect(provided).toHaveProperty(name.toLowerCase(), null);
    }
  });

  it("lets authored provided arguments re-expose a managed parameter", () => {
    const provided =
      define({ providedArguments: { "Accept-Language": "de-DE" } }).toolCall?.providedArguments ??
      {};
    expect(provided["Accept-Language"]).toBe("de-DE");
  });

  it("passes auth, approval, and the operation filter through", () => {
    const auth = { getToken: async () => ({ token: "t" }) };
    const connection = define({ auth, operations: { allow: ["create_checkout"] } });
    expect(connection.auth).toBeDefined();
    expect(connection.operations).toEqual({ allow: ["create_checkout"] });
  });

  it("passes the authored-definition validator eve applies at build time", () => {
    expect(() =>
      normalizeOpenApiConnectionDefinition(define(), 'Connection "acme":'),
    ).not.toThrow();
  });

  it("rejects an agent profile a merchant could not verify", () => {
    expect(() => define({ agent: { profile: "http://localhost:2000/.well-known/ucp" } })).toThrow(
      /must use https/,
    );
  });
});
