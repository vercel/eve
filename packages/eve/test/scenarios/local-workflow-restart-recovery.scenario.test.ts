import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { Client } from "../../src/client/client.js";
import { buildApplication } from "../../src/internal/nitro/host.js";
import {
  countLocalWorldActiveSteps,
  readLocalWorldWaits,
} from "../../src/internal/testing/local-world-database.js";
import { materializeScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { resolveLocalWorkflowWorldDataDirectory } from "../../src/internal/workflow/local-world-data-directory.js";
import { startPackagedEveStart } from "./eve-start-harness.js";

const AUTH = { basic: { username: "alice", password: "fixture" } };
const SLEEP_SECONDS = 15;

let app: Awaited<ReturnType<typeof materializeScenarioApp>>;

function stubProductionEnv(): void {
  vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "");
  vi.stubEnv("NODE_ENV", "production");
}

beforeAll(async () => {
  stubProductionEnv();
  try {
    app = await materializeScenarioApp({
      name: "local-workflow-restart",
      installDependencies: true,
      files: {
        "agent/agent.ts": `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  model: mockModel(async (request) => {
    if (request.toolResults.length > 0) return "Noted, Alice.";
    writeFileSync(join(process.cwd(), ".sleep-requested"), "");
    return { toolCalls: [{ name: "sleep", input: { seconds: ${SLEEP_SECONDS} } }] };
  }),
  modelContextWindowTokens: 32_000,
});`,
        "agent/tools/sleep.ts": `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "eve/workflow";
export default defineWorkflowTool({
  description: "Wait for a number of seconds.",
  inputSchema: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] },
  async execute({ seconds }: { seconds: number }) {
    "use workflow";
    await sleep(seconds * 1_000);
    return { waitedSeconds: seconds };
  },
});`,
        "agent/instructions.md": "Acknowledge Alice's messages briefly.\n",
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

async function postDelivery(url: string, proof?: string): Promise<Response> {
  return await fetch(new URL("/.well-known/workflow/v1/flow", url), {
    body: "{}",
    headers: proof === undefined ? {} : { "x-workflow-auth": proof },
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
}

it("finishes a spec 9 turn that was sleeping when `eve start` was killed", async () => {
  stubProductionEnv();
  const { appRoot } = app;
  const dataDir = resolveLocalWorkflowWorldDataDirectory(appRoot);
  await rm(dataDir, { force: true, recursive: true });
  await rm(join(appRoot, ".sleep-requested"), { force: true });

  let server = await startPackagedEveStart(appRoot);
  let sessionId: string;
  try {
    const { session } = await new Client({ baseUrl: server.url, auth: AUTH }).sessions.create();
    await session.send("Alice asks you to sleep, then acknowledge receipt.");
    sessionId = session.id;
    await expect
      .poll(() => existsSync(join(appRoot, ".sleep-requested")), { timeout: 30_000 })
      .toBe(true);
    await expect
      .poll(() => readLocalWorldWaits(dataDir).length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);
    await expect.poll(() => countLocalWorldActiveSteps(dataDir), { timeout: 30_000 }).toBe(0);
  } finally {
    await server.crash();
  }
  expect(readLocalWorldWaits(dataDir).map((wait) => wait.status)).not.toContain("completed");

  server = await startPackagedEveStart(appRoot);
  try {
    for (const proof of [undefined, "incorrect-delivery-proof"]) {
      const refused = await postDelivery(server.url, proof);
      expect(refused.status, server.stderr()).toBe(401);
      expect(await refused.json()).toEqual({
        code: "QUEUE_AUTH_REFUSED",
        error: "Unauthorized queue delivery",
      });
    }
    expect((await fetch(new URL("/", server.url), { method: "HEAD" })).status).toBe(200);

    const session = new Client({ baseUrl: server.url, auth: AUTH }).sessions.attach(sessionId);
    let outcome: string | undefined;
    try {
      for await (const event of session.stream({ signal: AbortSignal.timeout(60_000) })) {
        if (event.type !== "turn.settled") continue;
        outcome = event.data.outcome;
        break;
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
    }
    expect(outcome, `The turn did not settle within 60s.\n${server.stderr()}`).toBe("completed");
    expect(server.stdout() + server.stderr()).not.toContain("Skipping replay of stranded session");
  } finally {
    await server.stop();
  }
}, 180_000);
