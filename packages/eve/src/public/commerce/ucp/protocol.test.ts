import { describe, expect, it } from "vitest";

import {
  deriveUcpRequestUuid,
  ucpAgentHeaderValue,
  ucpShoppingRestSpecUrl,
  UCP_VERSION,
} from "#public/commerce/ucp/protocol.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("ucpAgentHeaderValue", () => {
  it("serializes the profile as a quoted dictionary member", () => {
    expect(ucpAgentHeaderValue({ profile: "https://agent.example/.well-known/ucp" })).toBe(
      'profile="https://agent.example/.well-known/ucp"',
    );
  });

  it("appends extra dictionary members after profile", () => {
    expect(
      ucpAgentHeaderValue({
        parameters: { deployment: "prod" },
        profile: "https://agent.example/p.json",
      }),
    ).toBe('profile="https://agent.example/p.json", deployment="prod"');
  });

  it("escapes quotes and backslashes in member values", () => {
    expect(
      ucpAgentHeaderValue({
        parameters: { note: 'a"b\\c' },
        profile: "https://agent.example/p.json",
      }),
    ).toBe('profile="https://agent.example/p.json", note="a\\"b\\\\c"');
  });

  it("rejects a non-https profile", () => {
    expect(() => ucpAgentHeaderValue({ profile: "http://agent.example/p.json" })).toThrow(
      /must use https/,
    );
  });

  it("rejects a relative profile", () => {
    expect(() => ucpAgentHeaderValue({ profile: "/.well-known/ucp" })).toThrow(
      /must be an absolute https URL/,
    );
  });
});

describe("deriveUcpRequestUuid", () => {
  it("produces a version 8 UUID", async () => {
    expect(await deriveUcpRequestUuid("idempotency:call-1:create_checkout")).toMatch(UUID_RE);
  });

  it("is stable for the same seed, so a replayed call reuses its key", async () => {
    const first = await deriveUcpRequestUuid("idempotency:call-1:create_checkout");
    const second = await deriveUcpRequestUuid("idempotency:call-1:create_checkout");
    expect(second).toBe(first);
  });

  it("differs across call ids and across purposes for one call", async () => {
    const [a, b, c] = await Promise.all([
      deriveUcpRequestUuid("idempotency:call-1:create_checkout"),
      deriveUcpRequestUuid("idempotency:call-2:create_checkout"),
      deriveUcpRequestUuid("request:call-1:create_checkout"),
    ]);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("ucpShoppingRestSpecUrl", () => {
  it("defaults to the targeted protocol version", () => {
    expect(ucpShoppingRestSpecUrl()).toBe(
      `https://ucp.dev/${UCP_VERSION}/services/shopping/rest.openapi.json`,
    );
  });

  it("resolves an older version", () => {
    expect(ucpShoppingRestSpecUrl("2026-01-11")).toBe(
      "https://ucp.dev/2026-01-11/services/shopping/rest.openapi.json",
    );
  });
});
