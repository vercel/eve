import { describe, expect, it } from "vitest";

import {
  resolveMcpPublicRequestUrl,
  validateMcpHttpRequest,
  validateMcpMetadataRequest,
} from "#internal/mcp/http-security.js";

describe("MCP HTTP security", () => {
  it("accepts secure non-browser requests and exact same-origin browser requests", () => {
    expect(validateMcpHttpRequest(request("https://agent.example/mcp"))).toBeUndefined();
    expect(
      validateMcpHttpRequest(
        request("https://agent.example/mcp", { origin: "https://agent.example" }),
      ),
    ).toBeUndefined();
  });

  it("rejects missing or mismatched Host headers", async () => {
    const missing = validateMcpHttpRequest(
      new Request("https://agent.example/mcp", { method: "POST" }),
    );
    expect(missing?.status).toBe(403);
    await expect(missing?.json()).resolves.toMatchObject({
      error: { message: "Missing Host header" },
    });

    const mismatched = validateMcpHttpRequest(
      request("https://agent.example/mcp", { host: "attacker.example" }),
    );
    expect(mismatched?.status).toBe(403);

    const mismatchedPort = validateMcpHttpRequest(
      request("https://agent.example/mcp", { host: "agent.example:444" }),
    );
    expect(mismatchedPort?.status).toBe(403);
    expect(
      validateMcpHttpRequest(
        request("https://agent.example/mcp", { host: "attacker.example@agent.example" }),
      )?.status,
    ).toBe(403);

    expect(validateMcpHttpRequest(request("https://agent.example:444/mcp"))).toBeUndefined();
  });

  it("rejects cross-origin browser requests including port changes", () => {
    expect(
      validateMcpHttpRequest(
        request("https://agent.example/mcp", { origin: "https://attacker.example" }),
      )?.status,
    ).toBe(403);
    expect(
      validateMcpHttpRequest(
        request("https://agent.example/mcp", { origin: "https://agent.example:444" }),
      )?.status,
    ).toBe(403);
  });

  it("validates proxied browser requests against their public origin", () => {
    const proxied = request("http://127.0.0.1:55335/mcp", {
      origin: "https://agent.example",
      "x-forwarded-host": "agent.example",
      "x-forwarded-proto": "https",
    });

    expect(validateMcpHttpRequest(proxied)).toBeUndefined();
    expect(resolveMcpPublicRequestUrl(proxied).toString()).toBe("https://agent.example/mcp");
    expect(
      validateMcpHttpRequest(
        request("http://127.0.0.1:55335/mcp", {
          origin: "https://attacker.example",
          "x-forwarded-host": "agent.example",
          "x-forwarded-proto": "https",
        }),
      )?.status,
    ).toBe(403);
    expect(
      validateMcpHttpRequest(
        request("http://agent.example/mcp", {
          "x-forwarded-host": "agent.example",
          "x-forwarded-proto": "https",
        }),
      )?.status,
    ).toBe(403);
  });

  it("rejects insecure or malformed forwarded origins", () => {
    expect(
      validateMcpHttpRequest(
        request("http://127.0.0.1:55335/mcp", {
          "x-forwarded-host": "agent.example",
          "x-forwarded-proto": "http",
        }),
      )?.status,
    ).toBe(403);
    expect(
      validateMcpHttpRequest(
        request("http://127.0.0.1:55335/mcp", {
          "x-forwarded-host": "agent.example/path",
          "x-forwarded-proto": "https",
        }),
      )?.status,
    ).toBe(400);
  });

  it("allows cross-origin OAuth metadata discovery while retaining base guards", () => {
    expect(
      validateMcpMetadataRequest(
        request("https://agent.example/.well-known/oauth-protected-resource", {
          origin: "https://client.example",
        }),
      ),
    ).toBeUndefined();
    expect(
      validateMcpMetadataRequest(
        request("https://agent.example/.well-known/oauth-protected-resource", {
          host: "attacker.example",
          origin: "https://client.example",
        }),
      )?.status,
    ).toBe(403);
  });

  it("allows plain HTTP only on loopback", () => {
    expect(validateMcpHttpRequest(request("http://localhost:2117/mcp"))).toBeUndefined();
    expect(validateMcpHttpRequest(request("http://127.0.0.7:2117/mcp"))).toBeUndefined();
    expect(validateMcpHttpRequest(request("http://127.attacker.example:2117/mcp"))?.status).toBe(
      403,
    );
    expect(validateMcpHttpRequest(request("http://agent.example/mcp"))?.status).toBe(403);
  });
});

function request(url: string, headers: Record<string, string> = {}): Request {
  const target = new URL(url);
  return new Request(url, {
    headers: { host: target.host, ...headers },
    method: "POST",
  });
}
