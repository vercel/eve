import { rm } from "node:fs/promises";

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { Client } from "../../src/client/client.js";
import { buildApplication } from "../../src/internal/nitro/host.js";
import { materializeScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { resolveLocalWorkflowWorldDataDirectory } from "../../src/internal/workflow/local-world-data-directory.js";
import { startPackagedEveStart } from "./eve-start-harness.js";

const AUTH = { basic: { username: "alice", password: "fixture" } };
const BUILD = {
  deployedAt: "2026-11-23T09:30:00.000Z",
  gitBranch: "release/workflow-steps",
  gitSha: "0f3c2a91d7",
};

let app: Awaited<ReturnType<typeof materializeScenarioApp>>;

function stubProductionEnv(): void {
  vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "");
  vi.stubEnv("NODE_ENV", "production");
}

beforeAll(async () => {
  stubProductionEnv();
  try {
    app = await materializeScenarioApp({
      name: "workflow-step-app",
      installDependencies: true,
      files: {
        "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  model: mockModel(async (request) =>
    request.toolResults.length > 0
      ? \`Checked in: \${JSON.stringify(request.toolResults[0]?.output)}\`
      : { toolCalls: [{ name: "check_in", input: {} }] },
  ),
  modelContextWindowTokens: 32_000,
});`,
        "agent/tools/check_in.ts": `import { defineTool } from "eve/tools";
export default defineTool({
  description: "Record that Alice checked in.",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    return { checkedIn: "alice" };
  },
});`,
        "agent/instructions.md": "Check Alice in, then confirm.\n",
        "agent/channels/eve.ts": `import { httpBasic } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
export default eveChannel({ auth: httpBasic({ username: "alice", password: "fixture" }) });`,
      },
    });
    await buildApplication(app.appRoot, { skipSandboxPrewarm: true });
  } finally {
    vi.unstubAllEnvs();
  }
}, 180_000);

afterAll(async () => {
  await app?.cleanup();
});

afterEach(() => vi.unstubAllEnvs());

it("runs the bundled turn step on `eve start` with the platform of the started app", async () => {
  stubProductionEnv();
  vi.stubEnv("VERCEL_DEPLOYMENT_CREATED_AT", BUILD.deployedAt);
  vi.stubEnv("VERCEL_GIT_COMMIT_REF", BUILD.gitBranch);
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", BUILD.gitSha);
  await rm(resolveLocalWorkflowWorldDataDirectory(app.appRoot), { force: true, recursive: true });

  const server = await startPackagedEveStart(app.appRoot);
  try {
    const { session } = await new Client({ baseUrl: server.url, auth: AUTH }).sessions.create();
    const accepted = await session.send("Alice arrived for her shift. Check her in.");
    let runtime: unknown;
    let reply: unknown;
    for await (const event of accepted.stream({ signal: AbortSignal.timeout(60_000) })) {
      if (event.type === "session.started") runtime = event.data.runtime;
      if (event.type === "content.completed" && event.data.phase === "reply")
        reply = event.data.value;
    }
    const result = await accepted.result({ signal: AbortSignal.timeout(30_000) });

    expect(result.status, server.stderr()).toBe("completed");
    expect(reply).toBe('Checked in: {"checkedIn":"alice"}');
    expect(runtime).toMatchObject({ build: BUILD });
  } finally {
    await server.stop();
  }
}, 180_000);
