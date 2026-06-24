import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { resolveEvalTargetHandle } from "#evals/target.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveEvalTargetHandle", () => {
  it("performs health/info handshake and exposes target capabilities", async () => {
    const fetches: Array<{ method: string; url: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = fetchUrl(request);
      fetches.push({ method: init?.method ?? "GET", url });

      if (url.endsWith("/eve/v1/health")) {
        return Response.json({ ok: true, status: "ready", workflowId: "wf" });
      }

      if (url.endsWith("/eve/v1/info")) {
        return Response.json(infoPayload({ name: "agent-basic-runtime" }));
      }

      if (url.endsWith("/eve/v1/dev/schedules/heartbeat")) {
        return Response.json({ scheduleId: "heartbeat", sessionIds: ["session-1"] });
      }

      return Response.json({ error: "not found" }, { status: 404 });
    });

    const client = new Client({ host: "http://127.0.0.1:3000" });
    const target = await resolveEvalTargetHandle({
      client,
      expectedAgentName: "agent-basic-runtime",
      kind: "local",
      url: "http://127.0.0.1:3000",
    });

    expect(target.url).toBe("http://127.0.0.1:3000");
    expect(target.capabilities).toEqual({ devRoutes: true });
    const { dispatchSchedule } = target;
    await expect(dispatchSchedule("heartbeat")).resolves.toEqual({
      scheduleId: "heartbeat",
      sessionIds: ["session-1"],
    });
    expect(fetches.map((fetch) => `${fetch.method} ${new URL(fetch.url).pathname}`)).toEqual([
      "GET /eve/v1/health",
      "GET /eve/v1/info",
      "POST /eve/v1/dev/schedules/heartbeat",
    ]);
  });

  it("fails when the target identity does not match the current app", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      const url = fetchUrl(request);
      if (url.endsWith("/eve/v1/health")) {
        return Response.json({ ok: true, status: "ready", workflowId: "wf" });
      }
      return Response.json(infoPayload({ name: "other-agent" }));
    });

    await expect(
      resolveEvalTargetHandle({
        client: new Client({ host: "http://127.0.0.1:3000" }),
        expectedAgentName: "agent-basic-runtime",
        kind: "remote",
        url: "http://127.0.0.1:3000",
      }),
    ).rejects.toThrow(/agent-basic-runtime/);
  });

  it("accepts a scoped package target when the runtime reports the app basename", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      const url = fetchUrl(request);
      if (url.endsWith("/eve/v1/health")) {
        return Response.json({ ok: true, status: "ready", workflowId: "wf" });
      }
      return Response.json(infoPayload({ name: "agent" }));
    });

    await expect(
      resolveEvalTargetHandle({
        client: new Client({ host: "http://127.0.0.1:4275" }),
        expectedAgentName: "@acme/agent",
        kind: "remote",
        url: "http://127.0.0.1:4275",
      }),
    ).resolves.toMatchObject({
      kind: "remote",
      url: "http://127.0.0.1:4275",
    });
  });

  it("rejects a scoped package target when the unscoped runtime name differs", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      const url = fetchUrl(request);
      if (url.endsWith("/eve/v1/health")) {
        return Response.json({ ok: true, status: "ready", workflowId: "wf" });
      }
      return Response.json(infoPayload({ name: "other-agent" }));
    });

    await expect(
      resolveEvalTargetHandle({
        client: new Client({ host: "http://127.0.0.1:4275" }),
        expectedAgentName: "@acme/agent",
        kind: "remote",
        url: "http://127.0.0.1:4275",
      }),
    ).rejects.toThrow(/@acme\/agent/);
  });
});

function fetchUrl(request: string | URL | Request): string {
  if (typeof request === "string") return request;
  if (request instanceof URL) return request.href;
  return request.url;
}

function infoPayload(input: { readonly name: string }) {
  return {
    agent: {
      agentRoot: "/tmp/app/agent",
      appRoot: "/tmp/app",
      model: { id: "mock" },
      name: input.name,
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
    workflow: { enabled: true, toolName: "workflow" },
    workspace: { resourceRoot: null, rootEntries: [] },
  };
}
