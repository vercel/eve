import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentInfoResponseError } from "#client/agent-info-error.js";
import { Client } from "#client/client.js";
import { ClientError } from "#client/client-error.js";
import { HealthResponseError } from "#client/health-response-error.js";
import { createTestAgentInfoResult } from "#internal/testing/agent-info-fixture.js";
import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";
import { resolveRemoteDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import { createDevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";

const AGENT_INFO = createTestAgentInfoResult({
  agentRoot: "/tmp/weather-agent/agent",
  appRoot: "/tmp/weather-agent",
  name: "Weather Agent",
});

function testBinding(
  logicalPath: string,
  owner:
    | { readonly kind: "application" }
    | { readonly feature: string; readonly kind: "framework" },
) {
  return {
    backing: {
      externalDependencies: [],
      kind: "filesystem" as const,
      sourcePath: `/tmp/weather-agent/agent/${logicalPath}`,
    },
    logicalPath,
    owner,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Client request policy", () => {
  it("rejects malformed health payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ ok: true, status: "ready", workflowId: "wf", extra: true }),
    );

    const client = new Client({ host: "https://eve.test" });

    await expect(client.health()).rejects.toThrow(HealthResponseError);
  });

  it("includes host query parameters on every agent request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(AGENT_INFO))
      .mockResolvedValueOnce(Response.json({ ok: true, status: "ready", workflowId: "wf" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({ sessionId: "session_1", status: "accepted" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        new Response(`${JSON.stringify({ data: {}, type: "session.completed" })}\n`),
      );
    const client = new Client({
      host: "https://eve.test?x-vercel-protection-bypass=secret",
    });

    await client.info();
    await client.health();
    await client.fetch("/custom");
    await (await client.sessions.create({ message: "hello" })).response.result();

    expect(fetchMock.mock.calls).toHaveLength(5);
    for (const [request] of fetchMock.mock.calls) {
      expect(new URL(String(request)).searchParams.get("x-vercel-protection-bypass")).toBe(
        "secret",
      );
    }
  });

  it("enforces its redirect policy for info, health, raw fetch, and sessions", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(AGENT_INFO))
      .mockResolvedValueOnce(Response.json({ ok: true, status: "ready", workflowId: "wf" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({ sessionId: "session_1", status: "accepted" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        new Response(`${JSON.stringify({ data: {}, type: "session.completed" })}\n`),
      );
    const client = new Client({ host: "https://eve.test", redirect: "manual" });

    await client.info();
    await client.health();
    await client.fetch("/custom", { redirect: "follow" });
    await (await client.sessions.create({ message: "hello" })).response.result();

    expect(fetchMock.mock.calls).toHaveLength(5);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.redirect).toBe("manual");
    }
  });

  it("applies its credentials policy to info, health, raw fetch, and sessions", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(AGENT_INFO))
      .mockResolvedValueOnce(Response.json({ ok: true, status: "ready", workflowId: "wf" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({ sessionId: "session_1", status: "accepted" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        new Response(`${JSON.stringify({ data: {}, type: "session.completed" })}\n`),
      );
    const client = new Client({ credentials: "include", host: "https://eve.test" });

    await client.info();
    await client.health();
    await client.fetch("/custom");
    await (await client.sessions.create({ message: "hello" })).response.result();

    expect(fetchMock.mock.calls).toHaveLength(5);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.credentials).toBe("include");
    }
  });

  it("allows a raw fetch to override its credentials policy", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    const client = new Client({ credentials: "include", host: "https://eve.test" });

    await client.fetch("/custom", { credentials: "omit" });

    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("omit");
  });

  it("expands vercelOidc auth into the bearer and trusted-oidc headers", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(AGENT_INFO));
    const client = new Client({
      host: "https://eve.test",
      auth: { vercelOidc: { token: () => Promise.resolve("oidc-tok") } },
    });

    await client.info();

    const sent = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(sent.get("authorization")).toBe("Bearer oidc-tok");
    expect(sent.get("x-vercel-trusted-oidc-idp-token")).toBe("oidc-tok");
  });

  it("lets turn authorization override the client bearer while retaining trusted OIDC", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ sessionId: "session_1", status: "accepted" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        new Response(`${JSON.stringify({ data: {}, type: "session.completed" })}\n`),
      );
    const client = new Client({
      host: "https://eve.test",
      auth: { vercelOidc: { token: "oidc-tok" } },
    });

    await (
      await client.sessions.create({
        headers: { authorization: "Bearer application-user" },
        message: "hello",
      })
    ).response.result();

    expect(fetchMock.mock.calls).toHaveLength(2);
    for (const [, init] of fetchMock.mock.calls) {
      const sent = new Headers(init?.headers);
      expect(sent.get("authorization")).toBe("Bearer application-user");
      expect(sent.get("x-vercel-trusted-oidc-idp-token")).toBe("oidc-tok");
    }
  });

  it("includes response headers in info request errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Redirecting...", {
        status: 302,
        headers: { location: "https://vercel.com/sso-api?url=https://eve.test" },
      }),
    );
    const client = new Client({ host: "https://eve.test", redirect: "manual" });

    const error = await client.info().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ClientError);
    expect((error as ClientError).headers.location).toBe(
      "https://vercel.com/sso-api?url=https://eve.test",
    );
  });

  it("keeps an in-flight remote request on one credential snapshot after rollback", async () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "bypass-secret");
    const target = await resolveTestVercelTarget({ host: "eve.test", projectId: "prj_eve" });
    const credentials = createDevelopmentCredentialGate("https://eve.test");
    const rollback = credentials.authorize({
      target,
      resolveToken: async () => "candidate-token",
    });
    const client = new Client(
      resolveRemoteDevelopmentClientOptions({ credentials, serverUrl: "https://eve.test" }),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));

    const request = client.fetch("/eve/v1/info");
    rollback();
    await request;

    const sent = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(sent.get("authorization")).toBe("Bearer candidate-token");
    expect(sent.get("x-vercel-protection-bypass")).toBe("bypass-secret");
    expect(sent.get("x-vercel-trusted-oidc-idp-token")).toBe("candidate-token");
    await expect(credentials.resolveToken()).resolves.toBe("");
  });

  it("accepts a tool whose undefined output schema was omitted during JSON serialization", async () => {
    const owner = { feature: "eve:defaults", kind: "framework" as const };
    const toolWithoutOutputSchema = {
      binding: testBinding("tools/web_search.ts", owner),
      description: "Search the web",
      hasAuth: false,
      hasExecute: false,
      hasModelOutputProjection: false,
      hasOutputSchema: false,
      inputSchema: null,
      logicalPath: "tools/web_search.ts",
      name: "web_search",
      owner,
      requiresApproval: false,
      sourceId: "eve:defaults:tools/web_search.ts",
      sourceKind: "module",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ...AGENT_INFO,
        tools: {
          ...AGENT_INFO.tools,
          static: [toolWithoutOutputSchema],
        },
      }),
    );
    const client = new Client({ host: "https://eve.test" });

    const info = await client.info();

    expect(info.tools.static[0]).toMatchObject({
      hasOutputSchema: false,
      name: "web_search",
    });
    expect(info.tools.static[0]).not.toHaveProperty("outputSchema");
  });

  it("rejects unknown fields in the agent info payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ...AGENT_INFO, ignoredByClient: true }),
    );
    const client = new Client({ host: "https://eve.test" });

    await expect(client.info()).rejects.toThrow(AgentInfoResponseError);
  });

  it("rejects duplicate public identities in the agent info payload", async () => {
    const owner = { kind: "application" as const };
    const tool = {
      binding: testBinding("tools/weather.ts", owner),
      description: "Gets weather.",
      hasAuth: false,
      hasExecute: true,
      hasModelOutputProjection: false,
      hasOutputSchema: false,
      inputSchema: { type: "object" },
      logicalPath: "tools/weather.ts",
      name: "weather",
      owner,
      requiresApproval: false,
      sourceId: "tools/weather.ts",
      sourceKind: "module",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ...AGENT_INFO,
        tools: {
          ...AGENT_INFO.tools,
          static: [
            tool,
            {
              ...tool,
              binding: testBinding("tools/forecast.ts", owner),
              logicalPath: "tools/forecast.ts",
              sourceId: "tools/forecast.ts",
            },
          ],
        },
      }),
    );
    const client = new Client({ host: "https://eve.test" });

    await expect(client.info()).rejects.toThrow(AgentInfoResponseError);
  });

  it("rejects normalized channel-route collisions in the agent info payload", async () => {
    const owner = { kind: "application" as const };
    const route = {
      binding: testBinding("channels/users.ts", owner),
      logicalPath: "channels/users.ts",
      method: "GET" as const,
      name: "users",
      owner,
      sourceId: "channels/users.ts",
      sourceKind: "module",
      urlPath: "/users/:id",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ...AGENT_INFO,
        channels: {
          ...AGENT_INFO.channels,
          routes: [
            route,
            {
              ...route,
              binding: testBinding("channels/profiles.ts", owner),
              logicalPath: "channels/profiles.ts",
              name: "profiles",
              sourceId: "channels/profiles.ts",
              urlPath: "/users/[profile]",
            },
          ],
        },
      }),
    );
    const client = new Client({ host: "https://eve.test" });

    await expect(client.info()).rejects.toThrow(AgentInfoResponseError);
  });

  it("rejects source provenance that disagrees with its compiled binding", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ...AGENT_INFO,
        sandbox: {
          ...AGENT_INFO.sandbox,
          binding: { ...AGENT_INFO.sandbox.binding, logicalPath: "sandbox/other.ts" },
        },
      }),
    );
    const client = new Client({ host: "https://eve.test" });

    await expect(client.info()).rejects.toThrow(AgentInfoResponseError);
  });

  it("rejects collection totals that disagree with their entries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ...AGENT_INFO, subagents: { local: [], total: 1 } }),
    );
    const client = new Client({ host: "https://eve.test" });

    await expect(client.info()).rejects.toThrow(AgentInfoResponseError);
  });

  it("rejects a non-Eve response from the agent info route", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ kind: "eve-agent-info", version: 1 }),
    );
    const client = new Client({ host: "https://eve.test" });

    await expect(client.info()).rejects.toThrow(AgentInfoResponseError);
  });

  it("rejects an incomplete agent info payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        agent: {
          model: {
            id: "openai/gpt-5.5",
            routing: { kind: "gateway", target: "openai" },
          },
        },
        diagnostics: { discoveryErrors: 0, discoveryWarnings: 0 },
        kind: "eve-agent-info",
        version: 1,
      }),
    );
    const client = new Client({ host: "https://eve.test" });

    await expect(client.info()).rejects.toThrow(AgentInfoResponseError);
  });

  it("names the offending fields when the agent info payload is incomplete", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        agent: {
          model: {
            id: "openai/gpt-5.5",
            routing: { kind: "gateway", target: "openai" },
          },
        },
        diagnostics: { discoveryErrors: 0, discoveryWarnings: 0 },
        kind: "eve-agent-info",
        version: 1,
      }),
    );
    const client = new Client({ host: "https://eve.test" });

    const error = await client.info().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AgentInfoResponseError);
    expect((error as AgentInfoResponseError).issues.length).toBeGreaterThan(0);
    expect((error as AgentInfoResponseError).message).toContain(":");
  });

  it("rejects a non-JSON body from the agent info route", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
    );
    const client = new Client({ host: "https://eve.test" });

    await expect(client.info()).rejects.toThrow(AgentInfoResponseError);
  });

  it.each([null, { kind: "gateway", connected: true }, { kind: "external" }])(
    "rejects an invalid model endpoint from the agent info route",
    async (endpoint) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({
          ...AGENT_INFO,
          agent: {
            ...AGENT_INFO.agent,
            model: { ...AGENT_INFO.agent.model, endpoint },
          },
        }),
      );
      const client = new Client({ host: "https://eve.test" });

      await expect(client.info()).rejects.toThrow(AgentInfoResponseError);
    },
  );
});
