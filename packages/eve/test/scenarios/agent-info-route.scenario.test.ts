import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { H3Event } from "nitro";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import type { AgentInfoResult } from "../../src/client/agent-info-schema.js";
import { createDevelopmentNitroArtifactsConfig } from "../../src/internal/nitro/host/artifacts-config.js";
import { dispatchChannelRequest } from "../../src/internal/nitro/routes/channel-dispatch.js";
import { EVE_INFO_ROUTE_PATH, EVE_SESSION_ROUTE_PATH } from "../../src/protocol/routes.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

const APP_ROOT_OPTIONS = { packageName: "agent-info-route-test-agent" } as const;
const INFO_ROUTE_KEY = `GET ${EVE_INFO_ROUTE_PATH}`;

// A request to the local server. The deployment environment, not this
// URL, decides auth: `localDev()` authenticates only when the process
// is an `eve dev` or `vercel dev` server (stubbed via EVE_DEV below).
const LOOPBACK_REQUEST = new Request("http://localhost/eve/v1/info");

// A request a real deployment sees on the wire. With no dev flag set,
// `localDev()` skips it and the walk falls through to `vercelOidc()`.
const DEPLOYED_REQUEST = new Request("https://weather-agent.vercel.app/eve/v1/info");
const AUTHORIZED_DEPLOYED_REQUEST = new Request("https://weather-agent.vercel.app/eve/v1/info", {
  headers: {
    "x-eve-info-token": "issue-389",
  },
});

type MinimalAgentInfoH3Event = Pick<H3Event, "context" | "waitUntil"> & {
  readonly req: Request;
};

// Authored fixture imports of `eve/tools` and `eve/channels/eve` resolve
// through the workspace package that `useTemporaryAppRoots` links into the
// app's node_modules. Never write into that link: it points at the real
// workspace package root.

function createInfoEvent(request: Request): H3Event {
  Object.assign(request, { ip: "127.0.0.1" });
  const event: MinimalAgentInfoH3Event = {
    context: { params: {} },
    req: request,
    waitUntil() {},
  };
  return event as H3Event;
}

async function requestAgentInfo(appRoot: string, request: Request): Promise<Response> {
  return await dispatchChannelRequest(
    createInfoEvent(request),
    INFO_ROUTE_KEY,
    createDevelopmentNitroArtifactsConfig({ configuredWorld: undefined, appRoot }),
  );
}

describe("eve agent info route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns inspection JSON in a local dev environment", async () => {
    vi.stubEnv("EVE_DEV", "1");

    const { agentRoot, appRoot } = await createAppRoot("eve-agent-info-route-", APP_ROOT_OPTIONS);

    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    await mkdir(join(agentRoot, "tools"), { recursive: true });
    await writeFile(
      join(agentRoot, "tools", "get_weather.mjs"),
      'export default { description: "Get the weather.", async execute() { return { temperature: 72 }; } };\n',
    );

    await compileAgent({
      startPath: appRoot,
    });

    const response = await requestAgentInfo(appRoot, LOOPBACK_REQUEST);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const payload = (await response.json()) as AgentInfoResult;

    expect(payload.kind).toBe("eve-agent-info");
    expect(payload.version).toBe(3);
    expect(payload.mode).toBe("development");
    expect(payload.agent.model.id).toBe("openai/gpt-5.4");
    expect(payload.instructions.entries[0]?.content).toContain("precise assistant");
    expect(payload.instructions.entries[0]?.role).toBe("system");
    expect(payload.instructions.dynamicResolvers).toEqual([]);
    expect(
      payload.tools.entries
        .filter((tool) => tool.source.owner === "application")
        .map((tool) => tool.name),
    ).toEqual(["get_weather"]);
    expect(payload.tools.entries.find((tool) => tool.name === "bash")?.source.owner).toBe(
      "framework",
    );
    expect(payload.kernel.prepared).toContainEqual(
      expect.objectContaining({ action: "subagent-call", kind: "dispatch", toolName: "agent" }),
    );
    expect(payload.channels.routes.map((route) => route.path)).toContain(EVE_SESSION_ROUTE_PATH);
    expect(
      payload.channels.routes.filter((route) => route.source.owner === "framework").length,
    ).toBeGreaterThan(0);
    expect(payload.diagnostics).toEqual({
      discoveryErrors: 0,
      discoveryWarnings: 0,
    });

    await writeFile(
      join(agentRoot, "tools", "agent.mjs"),
      'import { disableTool } from "eve/tools";\nexport default disableTool();\n',
    );
    await compileAgent({ startPath: appRoot });

    const disabledPayload = (await (
      await requestAgentInfo(appRoot, LOOPBACK_REQUEST)
    ).json()) as AgentInfoResult;

    expect(disabledPayload.kernel.prepared.map((entry) => entry.toolName)).not.toContain("agent");
    expect(disabledPayload.tools.entries.map((tool) => tool.name)).not.toContain("agent");
    expect(disabledPayload.composition.disabled).toContainEqual(
      expect.objectContaining({ slot: "tools/agent" }),
    );
  });

  it("returns 401 for a deployment request without a Vercel OIDC bearer token", async () => {
    // With no dev flag set, the default chain must reject a request that
    // carries no token: `vercelOidc()` skips without a bearer token and
    // `localDev()` skips outside an `eve dev` or `vercel dev` server.
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-agent-info-route-deployed-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");

    await compileAgent({
      startPath: appRoot,
    });

    const response = await requestAgentInfo(appRoot, DEPLOYED_REQUEST);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    // The unauthenticated response must not leak any agent metadata.
    const body = await response.text();
    expect(body).not.toMatch(/openai|gpt-5|gpt5/i);
    expect(body).not.toMatch(/precise assistant/i);
  });

  it("uses authored eve channel auth for public-hostname info requests", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-agent-info-route-authored-auth-",
      APP_ROOT_OPTIONS,
    );

    await mkdir(join(agentRoot, "channels"), { recursive: true });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    await writeFile(
      join(agentRoot, "channels", "eve.mjs"),
      `import { eveChannel } from "eve/channels/eve";

function issue389Auth(request) {
  if (request.headers.get("x-eve-info-token") !== "issue-389") {
    return null;
  }
  return {
    attributes: { source: "agent/channels/eve.mjs" },
    authenticator: "issue-389",
    principalId: "issue-389-user",
    principalType: "user",
  };
}

export default eveChannel({ auth: issue389Auth });
`,
    );

    await compileAgent({
      startPath: appRoot,
    });

    const rejected = await requestAgentInfo(appRoot, DEPLOYED_REQUEST);
    expect(rejected.status).toBe(401);

    const accepted = await requestAgentInfo(appRoot, AUTHORIZED_DEPLOYED_REQUEST);
    expect(accepted.status).toBe(200);

    const payload = (await accepted.json()) as AgentInfoResult;
    expect(payload.kind).toBe("eve-agent-info");
    expect(payload.agent.model.id).toBe("openai/gpt-5.4");
  });
});
