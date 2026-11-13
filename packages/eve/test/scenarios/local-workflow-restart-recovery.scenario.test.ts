import { existsSync, readFileSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { Client } from "../../src/client/client.js";
import { buildApplication } from "../../src/internal/nitro/host.js";
import { materializeScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { resolveLocalWorkflowWorldDataDirectory } from "../../src/internal/workflow/local-world-data-directory.js";
import { startPackagedEveStart } from "./eve-start-harness.js";

const AUTH = { basic: { username: "alice", password: "fixture" } };
// Long enough that the crash lands while it is pending, short enough that
// the restarted server does not idle until it fires.
const SLEEP_SECONDS = 5;

// One build serves both tests; each starts on its own empty local World.
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
        // The model reads which test sent the message: one hangs its first
        // call, the other sleeps in a workflow tool.
        "agent/agent.ts": `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
const started = join(process.cwd(), ".model-call-started");
export default defineAgent({
  model: mockModel(async (request) => {
    if (request.lastUserMessage?.includes("sleep")) {
      if (request.toolResults.length > 0) return "Noted, Alice.";
      writeFileSync(join(process.cwd(), ".sleep-requested"), "");
      return { toolCalls: [{ name: "sleep", input: { seconds: ${SLEEP_SECONDS} } }] };
    }
    // The first call never returns, so the process dies while it runs.
    if (!existsSync(started)) {
      writeFileSync(started, "");
      await new Promise(() => {});
    }
    return "Noted, Alice.";
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

function readStoredWaits(appRoot: string): { readonly status: string; readonly waitId: string }[] {
  const waits = join(resolveLocalWorkflowWorldDataDirectory(appRoot), "waits");
  if (!existsSync(waits)) return [];
  return readdirSync(waits)
    .filter((file) => file.endsWith(".json"))
    .map(
      (file) =>
        JSON.parse(readFileSync(join(waits, file), "utf8")) as { status: string; waitId: string },
    );
}

/**
 * Counts stored waits whose `wait_created` event is in their run's log. The
 * World writes a wait before its event, and a crash between the two leaves a
 * run that cannot replay, so the test crashes only once both are written.
 */
function countJournaledWaits(appRoot: string): number {
  const events = join(resolveLocalWorkflowWorldDataDirectory(appRoot), "events");
  if (!existsSync(events)) return 0;
  const journaled = new Set<string>();
  for (const runId of readdirSync(events)) {
    for (const file of readdirSync(join(events, runId))) {
      if (!file.endsWith(".json")) continue;
      const event = JSON.parse(readFileSync(join(events, runId, file), "utf8")) as {
        correlationId?: string;
        eventType?: string;
      };
      if (event.eventType === "wait_created") journaled.add(`${runId}-${event.correlationId}`);
    }
  }
  return readStoredWaits(appRoot).filter((wait) => journaled.has(wait.waitId)).length;
}

/**
 * Starts a turn, SIGKILLs `eve start` once the agent writes `crashMarker` and
 * the local World journals at least `storedWaits` waits, restarts on the same
 * data directory, and returns the turn's outcome, or undefined if it does not
 * settle within 60s.
 */
async function crashMidTurnAndRecover(input: {
  readonly message: string;
  readonly crashMarker: string;
  readonly storedWaits?: number;
}): Promise<{ readonly outcome: string | undefined; readonly stderr: string }> {
  stubProductionEnv();
  const { appRoot } = app;
  await rm(resolveLocalWorkflowWorldDataDirectory(appRoot), { force: true, recursive: true });
  await rm(join(appRoot, input.crashMarker), { force: true });

  let server = await startPackagedEveStart(appRoot);
  let sessionId: string;
  try {
    const { session } = await new Client({ baseUrl: server.url, auth: AUTH }).sessions.create();
    await session.send(input.message);
    sessionId = session.id;
    await expect
      .poll(() => existsSync(join(appRoot, input.crashMarker)), { timeout: 30_000 })
      .toBe(true);
    await expect
      .poll(() => countJournaledWaits(appRoot), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(input.storedWaits ?? 0);
  } finally {
    await server.crash();
  }
  // Every stored wait was still pending when the process died, so the
  // restarted server must arm their timers again.
  expect(readStoredWaits(appRoot).map((wait) => wait.status)).not.toContain("completed");

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
    message: "Alice asks you to acknowledge receipt.",
    crashMarker: ".model-call-started",
  });
  expect(outcome, `The turn did not settle within 60s.\n${stderr}`).toBe("completed");
}, 180_000);

// The local queue is in memory, so the wait's timer died with the process.
// Only a recovery message tells a spec 9 run to arm it again.
it("finishes a spec 9 turn that was sleeping when `eve start` was killed", async () => {
  const { outcome, stderr } = await crashMidTurnAndRecover({
    message: "Alice asks you to sleep, then acknowledge receipt.",
    crashMarker: ".sleep-requested",
    // The session's idle timeout and the sleep: the crash must lose a stored wait's timer.
    storedWaits: 2,
  });
  expect(outcome, `The turn did not settle within 60s.\n${stderr}`).toBe("completed");
}, 180_000);
