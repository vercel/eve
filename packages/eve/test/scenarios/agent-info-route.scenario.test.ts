import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { H3Event } from "nitro";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { createDevelopmentNitroArtifactsConfig } from "../../src/internal/nitro/host/artifacts-config.js";
import type { AgentInfoResponse } from "../../src/internal/nitro/routes/agent-info/build-agent-info-response.js";
import { installWorkflowEngine } from "../../src/execution/workflow-host/host.js";
import { builtInPlatform } from "../../src/platform/context.js";
import { dispatchChannelRequest } from "../../src/internal/nitro/routes/channel-dispatch.js";
import { EVE_INFO_ROUTE_PATH, EVE_SESSION_ROUTE_PATH } from "../../src/protocol/routes.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

const APP_ROOT_OPTIONS = { packageName: "agent-info-route-test-agent" } as const;
const INFO_ROUTE_KEY = `GET ${EVE_INFO_ROUTE_PATH}`;

const LOOPBACK_REQUEST = new Request("http://localhost/eve/v1/info");

const DEPLOYED_REQUEST = new Request("https://weather-agent.vercel.app/eve/v1/info");
function deployedInfoRequest(principalType: string): Request {
  return new Request("https://weather-agent.vercel.app/eve/v1/info", {
    headers: { "x-eve-info-principal": principalType, "x-eve-info-token": "issue-389" },
  });
}

type MinimalAgentInfoH3Event = Pick<H3Event, "context" | "waitUntil"> & {
  readonly req: Request;
};

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
  beforeAll(() => {
    installWorkflowEngine(builtInPlatform());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns inspection JSON to the local-dev principal in a local dev environment", async () => {
    vi.stubEnv("EVE_DEV", "1");

    const { agentRoot, appRoot } = await createAppRoot("eve-agent-info-route-", APP_ROOT_OPTIONS);

    await writeFile(
      join(agentRoot, "agent.mjs"),
      'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n',
    );
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

    const payload = (await response.json()) as AgentInfoResponse;

    expect(payload.kind).toBe("eve-agent-info");
    expect(payload.version).toBe(5);
    expect(payload.mode).toBe("development");
    expect(payload.agent.model.id).toBe("openai/gpt-5.4");
    expect(payload.instructions.static[0]?.content).toContain("precise assistant");
    expect(payload.instructions.static[0]?.role).toBe("system");
    expect(payload.instructions.dynamic).toEqual([]);
    expect(
      payload.tools.static
        .filter((tool) => tool.owner.kind === "application")
        .map((tool) => tool.name),
    ).toEqual(["get_weather"]);
    expect(payload.tools.static.map((tool) => tool.name)).toContain("bash");
    expect(payload.tools.static.map((tool) => tool.name)).toContain("agent");
    expect(payload.tools.static.map((tool) => tool.name)).toContain("get_weather");
    expect(payload.tools.static.find((tool) => tool.name === "bash")).toMatchObject({
      owner: { kind: "framework" },
    });
    expect(payload.tools.static.find((tool) => tool.name === "agent")).toMatchObject({
      owner: { kind: "framework" },
    });
    expect(payload.channels.routes.map((channel) => channel.urlPath)).toContain(
      EVE_SESSION_ROUTE_PATH,
    );
    expect(payload.channels.routes.some((channel) => channel.owner.kind === "framework")).toBe(
      true,
    );
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
    ).json()) as AgentInfoResponse;

    expect(disabledPayload.tools.static.map((tool) => tool.name)).not.toContain("agent");
    expect(
      disabledPayload.composition.disabled.some((entry) => entry.logicalPath === "tools/agent.mjs"),
    ).toBe(true);
  });

  it("returns 401 for a deployment request without a Vercel OIDC bearer token", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-agent-info-route-deployed-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(
      join(agentRoot, "agent.mjs"),
      'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n',
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");

    await compileAgent({
      startPath: appRoot,
    });

    const response = await requestAgentInfo(appRoot, DEPLOYED_REQUEST);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    const body = await response.text();
    expect(body).not.toMatch(/openai|gpt-5|gpt5/i);
    expect(body).not.toMatch(/precise assistant/i);
  });

  it("serves only operator principals admitted by authored eve channel auth", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-agent-info-route-authored-auth-",
      APP_ROOT_OPTIONS,
    );

    await mkdir(join(agentRoot, "channels"), { recursive: true });
    await writeFile(
      join(agentRoot, "agent.mjs"),
      'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n',
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    await writeFile(
      join(agentRoot, "channels", "eve.mjs"),
      `import { localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

function issue389Auth(request) {
  if (request.headers.get("x-eve-info-token") !== "issue-389") {
    return null;
  }
  return {
    attributes: { source: "agent/channels/eve.mjs" },
    authenticator: "issue-389",
    principalId: "issue-389-caller",
    principalType: request.headers.get("x-eve-info-principal") ?? "user",
  };
}

export default eveChannel({ auth: [issue389Auth, localDev()] });
`,
    );

    await compileAgent({
      startPath: appRoot,
    });

    const rejected = await requestAgentInfo(appRoot, DEPLOYED_REQUEST);
    expect(rejected.status).toBe(401);

    for (const principalType of ["user", "anonymous", "unknown"]) {
      const forbidden = await requestAgentInfo(appRoot, deployedInfoRequest(principalType));
      expect(forbidden.status).toBe(403);
      const body = await forbidden.text();
      expect(JSON.parse(body)).toMatchObject({ code: "info_forbidden", ok: false });
      expect(body).not.toMatch(/openai|gpt-5|precise assistant/i);
    }

    for (const principalType of ["service", "runtime"]) {
      const accepted = await requestAgentInfo(appRoot, deployedInfoRequest(principalType));
      expect(accepted.status).toBe(200);
      const payload = (await accepted.json()) as AgentInfoResponse;
      expect(payload.kind).toBe("eve-agent-info");
      expect(payload.agent.model.id).toBe("openai/gpt-5.4");
      expect(payload.instructions.static[0]?.content).toContain("precise assistant");
    }

    vi.stubEnv("EVE_DEV", "1");
    const localUser = await requestAgentInfo(
      appRoot,
      new Request("http://localhost/eve/v1/info", {
        headers: { "x-eve-info-principal": "user", "x-eve-info-token": "issue-389" },
      }),
    );
    expect(localUser.status).toBe(200);
  });
});
