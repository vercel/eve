import { rm } from "node:fs/promises";

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { Client } from "../../src/client/client.js";
import { resolvePackageSourceFilePath } from "../../src/internal/application/package.js";
import { buildApplication } from "../../src/internal/nitro/host.js";
import { materializeScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { resolveLocalWorkflowWorldDataDirectory } from "../../src/internal/workflow/local-world-data-directory.js";
import { startPackagedEveStart } from "./eve-start-harness.js";

const AUTH = { basic: { username: "alice", password: "fixture" } };

let app: Awaited<ReturnType<typeof materializeScenarioApp>>;

function stubProductionEnv(): void {
  vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "");
  vi.stubEnv("NODE_ENV", "production");
}

beforeAll(async () => {
  app = await materializeScenarioApp({
    name: "platform-module",
    installDependencies: true,
    files: {
      "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  model: mockModel(async (request) => \`Noted for Alice: \${request.messages.length} message(s).\`),
  modelContextWindowTokens: 32_000,
});`,
      "agent/instructions.md": "Take Alice's notes.\n",
      "agent/sandbox.ts": `import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";
export const environment = JustBashSandbox.environment({ idleTimeoutMs: 0 });
export default defineSandbox(() => environment.open());`,
      "agent/channels/eve.ts": `import { httpBasic } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
export default eveChannel({ auth: httpBasic({ username: "alice", password: "fixture" }) });`,
    },
  });
}, 180_000);

afterAll(async () => {
  await app?.cleanup();
});

afterEach(() => vi.unstubAllEnvs());

async function serveTwoTurns(platformModule: string | undefined) {
  stubProductionEnv();
  try {
    await buildApplication(app.appRoot, {
      ...(platformModule !== undefined && { platformModule }),
      skipSandboxPrewarm: false,
    });
  } finally {
    vi.unstubAllEnvs();
  }
  stubProductionEnv();
  await rm(resolveLocalWorkflowWorldDataDirectory(app.appRoot), { force: true, recursive: true });
  const server = await startPackagedEveStart(app.appRoot);
  try {
    const { session } = await new Client({ baseUrl: server.url, auth: AUTH }).sessions.create();
    const replies: unknown[] = [];
    let runtime: unknown;
    for (const message of ["Alice starts her notes.", "Alice adds a second note."]) {
      const accepted = await session.send(message);
      for await (const event of accepted.stream({ signal: AbortSignal.timeout(60_000) })) {
        if (event.type === "session.started") runtime = event.data.runtime;
        if (event.type === "content.completed" && event.data.phase === "reply")
          replies.push(event.data.value);
      }
      const result = await accepted.result({ signal: AbortSignal.timeout(30_000) });
      expect(result.status, server.stderr()).toBe("completed");
    }
    return { replies, runtime, sessionId: session.id };
  } finally {
    await server.stop();
  }
}

it("serves a session end to end on the engine of a platform module that gives context()", async () => {
  const served = await serveTwoTurns(
    resolvePackageSourceFilePath("src/internal/testing/store-platform.ts"),
  );

  expect(served.sessionId).toMatch(/^alice_/);
  expect(served.runtime).toMatchObject({
    build: {
      deployedAt: "2026-11-23T09:30:00.000Z",
      gitBranch: "alice/store-engine",
      gitSha: "a11ce5702e",
    },
  });
  expect(served.replies).toEqual([
    "Noted for Alice: 2 message(s).",
    "Noted for Alice: 4 message(s).",
  ]);
}, 240_000);

it("serves the same session on eve's Vercel declaration when the build selects no module", async () => {
  const served = await serveTwoTurns(undefined);

  expect(served.sessionId).not.toMatch(/^alice_/);
  expect(served.runtime).not.toHaveProperty("build");
  expect(served.replies).toEqual([
    "Noted for Alice: 2 message(s).",
    "Noted for Alice: 4 message(s).",
  ]);
}, 240_000);
