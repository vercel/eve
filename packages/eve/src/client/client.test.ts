import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentInfoResponseError } from "#client/agent-info-error.js";
import { Client } from "#client/client.js";
import { ClientError } from "#client/client-error.js";
import type { AgentInfoResult } from "#client/types.js";
import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";
import { resolveRemoteDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import { createDevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";

const AGENT_INFO: AgentInfoResult = {
  agent: {
    agentRoot: "/tmp/weather-agent/agent",
    appRoot: "/tmp/weather-agent",
    model: { id: "openai/gpt-5.5" },
    name: "Weather Agent",
  },
  capabilities: { devRoutes: true },
  channels: { authored: [], available: [], disabledFramework: [], framework: [] },
  connections: [],
  diagnostics: { discoveryErrors: 0, discoveryWarnings: 0 },
  hooks: [],
  instructions: { dynamic: [], static: null },
  kind: "eve-agent-info",
  mode: "development",
  sandbox: null,
  schedules: [],
  skills: { dynamic: [], static: [] },
  subagents: { local: [], total: 0 },
  tools: {
    authored: [],
    available: [],
    disabledFramework: [],
    dynamic: [],
    framework: [],
    reserved: [],
  },
  version: 1,
  workflow: { enabled: false, toolName: "Workflow" },
  workspace: { resourceRoot: null, rootEntries: [] },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Client request policy", () => {
  it("includes host query parameters on every agent request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(AGENT_INFO))
      .mockResolvedValueOnce(Response.json({ ok: true, status: "ready", workflowId: "wf" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({ continuationToken: "eve:test", sessionId: "session_1" }, { status: 202 }),
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
    await (await client.session().send("hello")).result();

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
        Response.json({ continuationToken: "eve:test", sessionId: "session_1" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        new Response(`${JSON.stringify({ data: {}, type: "session.completed" })}\n`),
      );
    const client = new Client({ host: "https://eve.test", redirect: "manual" });

    await client.info();
    await client.health();
    await client.fetch("/custom", { redirect: "follow" });
    await (await client.session().send("hello")).result();

    expect(fetchMock.mock.calls).toHaveLength(5);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.redirect).toBe("manual");
    }
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
    const toolWithoutOutputSchema = {
      description: "Search the web",
      hasAuth: false,
      hasExecute: false,
      hasModelOutputProjection: false,
      hasOutputSchema: false,
      inputSchema: null,
      logicalPath: "eve:framework/web-search",
      name: "web_search",
      origin: "framework",
      replacesFrameworkTool: false,
      requiresApproval: false,
      sourceKind: "module",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ...AGENT_INFO,
        tools: {
          ...AGENT_INFO.tools,
          available: [toolWithoutOutputSchema],
        },
      }),
    );
    const client = new Client({ host: "https://eve.test" });

    const info = await client.info();

    expect(info.tools.available[0]).toMatchObject({
      hasOutputSchema: false,
      name: "web_search",
    });
    expect(info.tools.available[0]).not.toHaveProperty("outputSchema");
  });

  it("returns the parsed agent info payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ...AGENT_INFO, ignoredByClient: true }),
    );
    const client = new Client({ host: "https://eve.test" });

    const info = await client.info();

    expect(info).not.toHaveProperty("ignoredByClient");
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
        agent: { model: { id: "openai/gpt-5.5" } },
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
        agent: { model: { id: "openai/gpt-5.5" } },
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
