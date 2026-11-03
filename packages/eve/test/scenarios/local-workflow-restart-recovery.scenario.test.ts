import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { Client } from "../../src/client/client.js";
import { buildApplication } from "../../src/internal/nitro/host.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startPackagedEveStart } from "./eve-start-harness.js";

const scenarioApp = useScenarioApp();
const AUTH = { basic: { username: "alice", password: "fixture" } };

afterEach(() => vi.unstubAllEnvs());

/**
 * Starts a turn, SIGKILLs `eve start` once the agent writes `crashMarker` and
 * `settleMs` passes, restarts on the same data directory, and returns the
 * turn's outcome, or undefined if it does not settle within 60s.
 */
async function crashMidTurnAndRecover(input: {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly crashMarker: string;
  readonly settleMs?: number;
}): Promise<{ readonly outcome: string | undefined; readonly stderr: string }> {
  vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "");
  vi.stubEnv("NODE_ENV", "production");
  const { appRoot } = await scenarioApp({
    name: input.name,
    installDependencies: true,
    files: {
      ...input.files,
      "agent/instructions.md": "Acknowledge Alice's messages briefly.\n",
      "agent/channels/eve.ts": `import { httpBasic } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
export default eveChannel({ auth: httpBasic({ username: "alice", password: "fixture" }) });`,
    },
  });
  await buildApplication(appRoot, { skipSandboxPrewarm: true });

  let server = await startPackagedEveStart(appRoot);
  let sessionId: string;
  try {
    const { session } = await new Client({ baseUrl: server.url, auth: AUTH }).sessions.create();
    await session.send("Alice asks you to acknowledge receipt.");
    sessionId = session.id;
    await expect
      .poll(() => existsSync(join(appRoot, input.crashMarker)), { timeout: 30_000 })
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, input.settleMs ?? 0));
  } finally {
    await server.crash();
  }

  server = await startPackagedEveStart(appRoot);
  try {
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
    return { outcome, stderr: server.stderr() };
  } finally {
    await server.stop();
  }
}

// Without releasing the dead process's steps, the restarted server defers to
// its inline-ownership lease (860s) before it runs the turn again.
it("finishes a spec 8 turn whose model call was running when `eve start` was killed", async () => {
  // Spec 8 runs stamp inline steps with their owner; sessions created before
  // eve moved to spec 9 keep that version for their whole life.
  vi.stubEnv("WORKFLOW_SPEC_VERSION", "8");
  const { outcome, stderr } = await crashMidTurnAndRecover({
    name: "local-workflow-restart-inline-step",
    crashMarker: ".model-call-started",
    files: {
      "agent/agent.ts": `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
const started = join(process.cwd(), ".model-call-started");
export default defineAgent({
  // The first call never returns, so the process dies while it runs.
  model: mockModel(async () => {
    if (!existsSync(started)) {
      writeFileSync(started, "");
      await new Promise(() => {});
    }
    return "Noted, Alice.";
  }),
  modelContextWindowTokens: 32_000,
});`,
    },
  });
  expect(outcome, `The turn did not settle within 60s.\n${stderr}`).toBe("completed");
}, 180_000);

// The local queue is in memory, so the wait's timer died with the process.
// Only a recovery message tells a spec 9 run to arm it again.
it("finishes a spec 9 turn that was sleeping when `eve start` was killed", async () => {
  const { outcome, stderr } = await crashMidTurnAndRecover({
    name: "local-workflow-restart-sleep",
    crashMarker: ".sleep-requested",
    // Long enough for the sleep's wait to be stored before the crash.
    settleMs: 3_000,
    files: {
      "agent/agent.ts": `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  model: mockModel((request) => {
    if (request.toolResults.length > 0) return "Noted, Alice.";
    writeFileSync(join(process.cwd(), ".sleep-requested"), "");
    return { toolCalls: [{ name: "sleep", input: { seconds: 25 } }] };
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
    },
  });
  expect(outcome, `The turn did not settle within 60s.\n${stderr}`).toBe("completed");
}, 180_000);
