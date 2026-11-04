import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, it, vi } from "vitest";

import { Client } from "../../src/client/index.js";
import { buildApplication } from "../../src/internal/nitro/host.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { DEV_SERVER_SCENARIO_TIMEOUT_MS } from "./dev-server-descriptors.js";
import { startEveDev, waitForCondition } from "./dev-server-harness.js";
import { startPackagedEveStart } from "./eve-start-harness.js";

const scenarioApp = useScenarioApp();

afterEach(() => vi.unstubAllEnvs());

const AUTH = { basic: { username: "alice", password: "fixture" } };

/** Far below the 860 s inline-ownership lease a dead owner's step waits out today. */
const RERUN_DEADLINE_MS = 30_000;

/** One tool call to `hold`, which records each start and then blocks until released. */
const DESCRIPTOR: ScenarioAppDescriptor = {
  dependencies: { zod: "^4.3.6" },
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  model: mockModel(({ toolResults }) =>
    toolResults.length === 0 ? { toolCalls: [{ name: "hold" }] } : "Released.",
  ),
  modelContextWindowTokens: 32_000,
});`,
    "agent/instructions.md": "Call hold.\n",
    "agent/channels/eve.ts": `import { httpBasic } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
export default eveChannel({ auth: httpBasic({ username: "alice", password: "fixture" }) });`,
    "agent/tools/hold.ts": `import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Blocks until the test releases it.",
  inputSchema: z.object({}),
  async execute() {
    appendFileSync(join(process.cwd(), ".hold-starts"), String(process.pid) + "\\n");
    while (!existsSync(join(process.cwd(), ".hold-release"))) await sleep(50);
    return "released";
  },
});`,
  },
  installDependencies: true,
  name: "crashed-step-recovery",
};

async function readHoldStarts(appRoot: string): Promise<string[]> {
  try {
    return (await readFile(join(appRoot, ".hold-starts"), "utf8")).trim().split("\n");
  } catch {
    return [];
  }
}

interface Server {
  readonly url: string;
  stderr(): string;
  stdout(): string;
}

/**
 * Sends a message whose turn blocks inside `hold`, crashes the server mid-tool, restarts it, and
 * requires the interrupted tool to run again within {@link RERUN_DEADLINE_MS}.
 */
async function expectInterruptedToolToRerun(input: {
  readonly appRoot: string;
  readonly crash: () => Promise<void>;
  readonly first: Server;
  readonly restart: () => Promise<Server>;
}): Promise<void> {
  const { session } = await new Client({ baseUrl: input.first.url, auth: AUTH }).sessions.create();
  await session.send("Call hold.");
  await waitForCondition(
    async () => (await readHoldStarts(input.appRoot)).length === 1,
    () => `hold never started.\n${input.first.stdout()}\n${input.first.stderr()}`,
  );

  await input.crash();
  const restarted = await input.restart();

  await waitForCondition(
    async () => (await readHoldStarts(input.appRoot)).length >= 2,
    () =>
      `The tool interrupted by the crash did not run again within ${String(RERUN_DEADLINE_MS / 1000)} s ` +
      `of the restart.\n${restarted.stdout()}\n${restarted.stderr()}`,
    RERUN_DEADLINE_MS,
  );
  await writeFile(join(input.appRoot, ".hold-release"), "");
}

describe("crash recovery of a step that was running", () => {
  // Bug: recovery re-enqueues the run under a new queue message id, so the step's inline
  // ownership stamp still names the dead process's message and the step waits out the lease.
  it.fails(
    "re-runs the interrupted tool right after `eve dev --resume`",
    async () => {
      const { appRoot } = await scenarioApp(DESCRIPTOR);
      let server = await startEveDev(appRoot);
      try {
        await expectInterruptedToolToRerun({
          appRoot,
          crash: async () => {
            await server.crash();
            await waitForCondition(async () => {
              try {
                await readFile(join(appRoot, ".eve", "dev-server-state.v1.json"));
                return false;
              } catch (error) {
                return error instanceof Error && "code" in error && error.code === "ENOENT";
              }
            }, "The crashed development server did not release its state record.");
          },
          first: server,
          restart: async () => (server = await startEveDev(appRoot, { resume: true })),
        });
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it.fails(
    "re-runs the interrupted tool right after `eve start` restarts",
    async () => {
      vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "");
      vi.stubEnv("NODE_ENV", "production");
      const { appRoot } = await scenarioApp(DESCRIPTOR);
      await buildApplication(appRoot, { skipSandboxPrewarm: true });
      let server = await startPackagedEveStart(appRoot);
      try {
        await expectInterruptedToolToRerun({
          appRoot,
          crash: async () => await server.crash(),
          first: server,
          restart: async () => (server = await startPackagedEveStart(appRoot)),
        });
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
