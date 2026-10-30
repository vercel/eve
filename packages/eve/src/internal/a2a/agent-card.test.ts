import { describe, expect, it } from "vitest";

import { agentCardResponse, buildAgentCard, type BuildAgentCardInput } from "./agent-card.js";

const base: BuildAgentCardInput = {
  described: { description: "Plans trips.", name: "travel", skills: [], tools: [] },
  endpointUrl: "https://agent.example.com/eve/v1/a2a",
  eveVersion: "1.2.3",
  fileInputModes: ["*/*"],
  options: undefined,
  security: { anonymous: false, challenges: [], oauth: undefined },
};

describe("buildAgentCard", () => {
  it("describes the agent, its JSON-RPC interface, and its capabilities", () => {
    expect(buildAgentCard(base)).toMatchObject({
      capabilities: { extendedAgentCard: false, pushNotifications: false, streaming: true },
      defaultInputModes: ["text/plain", "application/json", "*/*"],
      description: "Plans trips.",
      name: "travel",
      skills: [{ description: "Plans trips.", id: "default", name: "travel", tags: [] }],
      supportedInterfaces: [
        { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: base.endpointUrl },
      ],
      version: "1.2.3",
    });
  });

  it("advertises eve skills as A2A skills", () => {
    const card = buildAgentCard({
      ...base,
      described: {
        ...base.described,
        skills: [{ description: "Books flights.", name: "flights" } as never],
      },
    });
    expect(card.skills).toEqual([
      { description: "Books flights.", id: "flights", name: "flights", tags: [] },
    ]);
  });

  it("reads security from the auth policy", () => {
    expect(
      buildAgentCard({ ...base, security: { ...base.security, anonymous: true } }),
    ).not.toHaveProperty("securitySchemes");
    // Undeclared strategies fall back to Bearer, as routeAuth's 401 does.
    expect(buildAgentCard(base)).toMatchObject({
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
    });
    const both = buildAgentCard({
      ...base,
      security: {
        anonymous: false,
        challenges: [{ scheme: "Basic" }, { scheme: "Bearer" }],
        oauth: { issuer: "https://issuer.example.com", scopes: ["agent:invoke"] },
      },
    });
    expect(both.securityRequirements).toEqual([
      { schemes: { basic: { list: [] } } },
      { schemes: { bearer: { list: ["agent:invoke"] } } },
    ]);
    expect(both.securitySchemes).toMatchObject({
      basic: { httpAuthSecurityScheme: { scheme: "Basic" } },
      bearer: {
        httpAuthSecurityScheme: {
          description: "An OAuth 2.0 access token from https://issuer.example.com.",
          scheme: "Bearer",
        },
      },
    });
  });

  it("lets the application override card fields and security", () => {
    const card = buildAgentCard({
      ...base,
      options: {
        description: "Custom.",
        provider: { organization: "Acme", url: "https://acme.example.com" },
        securitySchemes: { key: { apiKeySecurityScheme: { location: "header", name: "x-key" } } },
        version: "9.9.9",
      },
    });
    expect(card).toMatchObject({
      description: "Custom.",
      provider: { organization: "Acme" },
      securitySchemes: { key: { apiKeySecurityScheme: { name: "x-key" } } },
      version: "9.9.9",
    });
    expect(card).not.toHaveProperty("securityRequirements");
    expect(card).not.toHaveProperty("iconUrl");
  });
});

describe("agentCardResponse", () => {
  const card = { name: "agent" };
  const get = (headers: Record<string, string> = {}) =>
    agentCardResponse(
      new Request("http://127.0.0.1/.well-known/agent-card.json", { headers }),
      card,
      {
        "cache-control": "public, max-age=300",
      },
    );

  it("serves the card with validators, and 304 when a client's copy is current", async () => {
    const first = await get();
    const etag = first.headers.get("etag")!;
    const lastModified = first.headers.get("last-modified")!;
    expect(await first.json()).toEqual(card);
    expect(etag).toMatch(/^"[\w-]{27}"$/u);
    expect((await get()).headers.get("etag")).toBe(etag);

    const notModified = await get({ "if-none-match": `"other", W/${etag}` });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(etag);
    expect(notModified.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await get({ "if-modified-since": lastModified })).status).toBe(304);
  });

  it("serves the card when the client's copy is stale, preferring If-None-Match", async () => {
    expect((await get({ "if-none-match": '"stale"' })).status).toBe(200);
    expect((await get({ "if-modified-since": "Thu, 01 Jan 2015 00:00:00 GMT" })).status).toBe(200);
    // A non-matching ETag wins over a current date.
    const future = new Date(Date.now() + 60_000).toUTCString();
    expect((await get({ "if-modified-since": future, "if-none-match": '"stale"' })).status).toBe(
      200,
    );
  });
});
