import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import type { AgentInfoResponse } from "../../src/internal/nitro/routes/agent-info/build-agent-info-response.js";
import { handleAgentInfoRequest } from "../../src/internal/nitro/routes/info.js";
import { EVE_CREATE_SESSION_ROUTE_PATH } from "../../src/protocol/routes.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

const APP_ROOT_OPTIONS = { packageName: "agent-info-route-test-agent" } as const;

// Loopback request — `localDev()` authenticates this one. Models a
// developer hitting `eve start` or `vercel dev` on their machine.
const LOOPBACK_REQUEST = new Request("http://localhost/eve/v1/info");

// Public-hostname request — what a real Vercel (or self-hosted)
// deployment sees on the wire. `localDev()` skips this because the
// request was not addressed to a loopback hostname, so the walk falls
// through to `vercelOidc()`.
const DEPLOYED_REQUEST = new Request("https://weather-agent.vercel.app/eve/v1/info");

describe("handleAgentInfoRequest", () => {
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

    const response = await handleAgentInfoRequest({ appRoot }, LOOPBACK_REQUEST);

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
    // The default chain `[localDev(), vercelOidc()]` must reject public
    // traffic that arrives without a token, regardless of `process.env`.
    // `localDev()` skips because the request URL is not loopback;
    // `vercelOidc()` rejects because there is no bearer token.
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-agent-info-route-deployed-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");

    await compileAgent({
      startPath: appRoot,
    });

    const response = await handleAgentInfoRequest({ appRoot }, DEPLOYED_REQUEST);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    // The unauthenticated response must not leak any agent metadata.
    const body = await response.text();
    expect(body).not.toMatch(/openai|gpt-5|gpt5/i);
    expect(body).not.toMatch(/precise assistant/i);
  });
});
