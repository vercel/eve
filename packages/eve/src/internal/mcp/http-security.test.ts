import { describe, expect, it } from "vitest";

import { validateMcpHttpRequest, validateMcpMetadataRequest } from "#internal/mcp/http-security.js";

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
