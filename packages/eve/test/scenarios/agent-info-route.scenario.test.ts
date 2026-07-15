import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { H3Event } from "nitro";
import { describe, expect, it } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { createDevelopmentNitroArtifactsConfig } from "../../src/internal/nitro/host/artifacts-config.js";
import type { AgentInfoResponse } from "../../src/internal/nitro/routes/agent-info/build-agent-info-response.js";
import { dispatchChannelRequest } from "../../src/internal/nitro/routes/channel-dispatch.js";
import { EVE_CREATE_SESSION_ROUTE_PATH, EVE_INFO_ROUTE_PATH } from "../../src/protocol/routes.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

const APP_ROOT_OPTIONS = { packageName: "agent-info-route-test-agent" } as const;
const EVE_CHANNEL_IMPORT_URL = new URL("../../dist/src/public/channels/eve.js", import.meta.url);
const INFO_ROUTE_KEY = `GET ${EVE_INFO_ROUTE_PATH}`;

// Loopback request — `localDev()` authenticates this one. Models a
// developer hitting `eve start` or `vercel dev` on their machine.
const LOOPBACK_REQUEST = new Request("http://localhost/eve/v1/info");

// Public-hostname request — what a real Vercel (or self-hosted)
// deployment sees on the wire. `localDev()` skips this because the
// request was not addressed to a loopback hostname, so the walk falls
// through to `vercelOidc()`.
const DEPLOYED_REQUEST = new Request("https://weather-agent.vercel.app/eve/v1/info");
const AUTHORIZED_DEPLOYED_REQUEST = new Request("https://weather-agent.vercel.app/eve/v1/info", {
  headers: {
    "x-eve-info-token": "issue-389",
  },
});

type MinimalAgentInfoH3Event = Pick<H3Event, "context" | "waitUntil"> & {
  readonly req: Request;
};

async function installEveChannelShim(appRoot: string): Promise<void> {
  const packageRoot = join(appRoot, "node_modules", "eve");
  await mkdir(join(packageRoot, "channels"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "eve",
        type: "module",
        exports: {
          "./channels/eve": "./channels/eve.js",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(packageRoot, "channels", "eve.js"),
    `export { eveChannel } from ${JSON.stringify(EVE_CHANNEL_IMPORT_URL.href)};\n`,
  );
}

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
  it("returns inspection JSON when the request is addressed to a loopback hostname", async () => {
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

    const payload = (await response.json()) as AgentInfoResponse;

    expect(payload.kind).toBe("eve-agent-info");
    expect(payload.version).toBe(1);
    expect(payload.mode).toBe("development");
    expect(payload.agent.model.id).toBe("openai/gpt-5.4");
    expect(payload.instructions.static?.markdown).toContain("precise assistant");
    expect(payload.instructions.dynamic).toEqual([]);
    expect(payload.tools.authored.map((tool) => tool.name)).toEqual(["get_weather"]);
    expect(payload.tools.available.map((tool) => tool.name)).toContain("bash");
    expect(payload.tools.available.map((tool) => tool.name)).toContain("get_weather");
    expect(payload.tools.framework.find((tool) => tool.name === "bash")).toMatchObject({
      origin: "framework",
      status: "active",
    });
    expect(payload.channels.available.map((channel) => channel.urlPath)).toContain(
      EVE_CREATE_SESSION_ROUTE_PATH,
    );
    expect(payload.channels.framework.length).toBeGreaterThan(0);
    expect(payload.diagnostics).toEqual({
      discoveryErrors: 0,
      discoveryWarnings: 0,
    });
  });

  it("returns 401 without a Vercel OIDC bearer token when the request is addressed to a public hostname", async () => {
    // The default chain `[vercelOidc(), localDev()]` must reject public
    // traffic that arrives without a token, regardless of `process.env`.
    // `vercelOidc()` skips because there is no bearer token; `localDev()`
    // skips because the request URL is not loopback.
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
    await installEveChannelShim(appRoot);
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

    const payload = (await accepted.json()) as AgentInfoResponse;
    expect(payload.kind).toBe("eve-agent-info");
    expect(payload.agent.model.id).toBe("openai/gpt-5.4");
  });
});
