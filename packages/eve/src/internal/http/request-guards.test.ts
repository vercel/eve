import { describe, expect, it } from "vitest";

import {
  clientUrl,
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

  it("accepts plain HTTP X-Forwarded-Proto says arrived as HTTPS, only under forwarded-https", () => {
    const forwarded = (headers: Record<string, string> = {}) =>
      request("http://agent.internal:3000/a2a", { "x-forwarded-proto": "https", ...headers });

    expect(validateHttpEndpointRequest(forwarded(), "A2A")?.status).toBe(403);
    expect(validateHttpEndpointRequest(forwarded(), "A2A", "forwarded-https")).toBeUndefined();
    // The first value is the client's hop.
    expect(
      validateHttpEndpointRequest(
        forwarded({ "x-forwarded-proto": "http, https" }),
        "A2A",
        "forwarded-https",
      )?.status,
    ).toBe(403);
    expect(
      validateHttpEndpointRequest(
        request("http://agent.internal:3000/a2a"),
        "A2A",
        "forwarded-https",
      )?.status,
    ).toBe(403);
    // A browser behind the proxy sends its HTTPS origin, which is the one it addressed.
    expect(
      validateHttpEndpointRequest(
        forwarded({ origin: "https://agent.internal" }),
        "A2A",
        "forwarded-https",
      ),
    ).toBeUndefined();
    expect(
      validateHttpEndpointRequest(
        forwarded({ origin: "http://agent.internal:3000" }),
        "A2A",
        "forwarded-https",
      )?.status,
    ).toBe(403);
    // Host is still checked against the URL eve received.
    expect(
      validateHttpEndpointRequest(forwarded({ host: "attacker.example" }), "A2A", "forwarded-https")
        ?.status,
    ).toBe(403);
    expect(validateHttpMetadataRequest(forwarded(), "A2A", "forwarded-https")).toBeUndefined();
  });

  it("reads the client's URL as HTTPS only when forwarded-https trusts the header", () => {
    const forwarded = request("http://agent.internal:3000/mcp?x=1", {
      "x-forwarded-proto": "https",
    });
    expect(clientUrl(forwarded, "forwarded-https").href).toBe("https://agent.internal/mcp?x=1");
    expect(clientUrl(forwarded).href).toBe("http://agent.internal:3000/mcp?x=1");
    expect(clientUrl(forwarded, "allow").href).toBe("http://agent.internal:3000/mcp?x=1");
  });

  it("accepts plain HTTP from any host under allow, keeping the Host and Origin checks", () => {
    const internal = request("http://agent.svc.cluster.local/a2a");
    expect(validateHttpEndpointRequest(internal, "A2A", "allow")).toBeUndefined();
    expect(validateHttpMetadataRequest(internal, "A2A", "allow")).toBeUndefined();
    expect(
      validateHttpEndpointRequest(
        request("http://agent.svc.cluster.local/a2a", { host: "attacker.example" }),
        "A2A",
        "allow",
      )?.status,
    ).toBe(403);
    expect(
      validateHttpEndpointRequest(
        request("http://agent.svc.cluster.local/a2a", { origin: "https://attacker.example" }),
        "A2A",
        "allow",
      )?.status,
    ).toBe(403);
  });
});

function request(url: string, headers: Record<string, string> = {}): Request {
  const target = new URL(url);
  return new Request(url, {
    headers: { host: target.host, ...headers },
    method: "POST",
  });
}
