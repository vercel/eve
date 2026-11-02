import { describe, expect, it } from "vitest";

import {
  validateHttpEndpointRequest,
  validateHttpMetadataRequest,
} from "#internal/http/request-guards.js";

describe("HTTP request guards", () => {
  it("accepts secure non-browser requests and exact same-origin browser requests", () => {
    expect(
      validateHttpEndpointRequest(request("https://agent.example/mcp"), "MCP"),
    ).toBeUndefined();
    expect(
      validateHttpEndpointRequest(
        request("https://agent.example/mcp", { origin: "https://agent.example" }),
        "MCP",
      ),
    ).toBeUndefined();
  });

  it("rejects missing or mismatched Host headers", async () => {
    const missing = validateHttpEndpointRequest(
      new Request("https://agent.example/mcp", { method: "POST" }),
      "MCP",
    );
    expect(missing?.status).toBe(403);
    await expect(missing?.json()).resolves.toMatchObject({
      error: { message: "Missing Host header" },
    });

    const mismatched = validateHttpEndpointRequest(
      request("https://agent.example/mcp", { host: "attacker.example" }),
      "MCP",
    );
    expect(mismatched?.status).toBe(403);

    const mismatchedPort = validateHttpEndpointRequest(
      request("https://agent.example/mcp", { host: "agent.example:444" }),
      "MCP",
    );
    expect(mismatchedPort?.status).toBe(403);
    expect(
      validateHttpEndpointRequest(
        request("https://agent.example/mcp", { host: "attacker.example@agent.example" }),
        "MCP",
      )?.status,
    ).toBe(403);

    expect(
      validateHttpEndpointRequest(request("https://agent.example:444/mcp"), "MCP"),
    ).toBeUndefined();
  });

  it("rejects cross-origin browser requests including port changes", () => {
    expect(
      validateHttpEndpointRequest(
        request("https://agent.example/mcp", { origin: "https://attacker.example" }),
        "MCP",
      )?.status,
    ).toBe(403);
    expect(
      validateHttpEndpointRequest(
        request("https://agent.example/mcp", { origin: "https://agent.example:444" }),
        "MCP",
      )?.status,
    ).toBe(403);
  });

  it("allows cross-origin OAuth metadata discovery while retaining base guards", () => {
    expect(
      validateHttpMetadataRequest(
        request("https://agent.example/.well-known/oauth-protected-resource", {
          origin: "https://client.example",
        }),
        "MCP",
      ),
    ).toBeUndefined();
    expect(
      validateHttpMetadataRequest(
        request("https://agent.example/.well-known/oauth-protected-resource", {
          host: "attacker.example",
          origin: "https://client.example",
        }),
        "MCP",
      )?.status,
    ).toBe(403);
  });

  it("allows plain HTTP only on loopback", () => {
    expect(
      validateHttpEndpointRequest(request("http://localhost:2117/mcp"), "MCP"),
    ).toBeUndefined();
    expect(
      validateHttpEndpointRequest(request("http://127.0.0.7:2117/mcp"), "MCP"),
    ).toBeUndefined();
    expect(
      validateHttpEndpointRequest(request("http://127.attacker.example:2117/mcp"), "MCP")?.status,
    ).toBe(403);
    expect(validateHttpEndpointRequest(request("http://agent.example/mcp"), "MCP")?.status).toBe(
      403,
    );
  });
});

function request(url: string, headers: Record<string, string> = {}): Request {
  const target = new URL(url);
  return new Request(url, {
    headers: { host: target.host, ...headers },
    method: "POST",
  });
}
