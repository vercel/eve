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
// Long enough that the crash lands while it is pending on a slow runner, with
// over 10 s to spare, short enough that the restarted server does not idle until
// it fires.
const SLEEP_SECONDS = 15;

// The one test that kills a real `eve start`: what a restart does with a session's runs and waits
// on the local World is the host battery's (`internal/testing/session-host/`), which restarts the
// World in process. Only a real process boots the built server, applies its spec version, runs the
// World's start-time recovery through the stranded-run guard, which must replay a run this build
// owns, mounts the flow route with its queue key, and leaves a SIGKILLed process group's files
// behind. That the guard is installed and skips a stranded run is `install-workflow-world.test.ts`'s.
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
        // The model sleeps in a workflow tool, then answers.
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
 * Counts stored steps a crash would catch mid-write: running ones, and settled ones whose
 * `step_completed` or `step_failed` isn't in their run's log yet. world-local stores a step's
 * terminal state before its event, so a crash between the two leaves a step the replay can't
 * settle again ("Cannot modify step in terminal state").
 */
function countUnsettledSteps(appRoot: string): number {
  const dataDir = resolveLocalWorkflowWorldDataDirectory(appRoot);
  const steps = join(dataDir, "steps");
  if (!existsSync(steps)) return 0;
  let unsettled = 0;
  for (const runId of readdirSync(steps)) {
    const events = join(dataDir, "events", runId);
    const settled = new Set<string>();
    for (const file of existsSync(events) ? readdirSync(events) : []) {
      if (!file.endsWith(".json")) continue;
      const event = JSON.parse(readFileSync(join(events, file), "utf8")) as {
        correlationId?: string;
        eventType?: string;
      };
      if (event.eventType === "step_completed" || event.eventType === "step_failed") {
        settled.add(`${runId}-${event.correlationId}`);
      }
    }
    for (const file of readdirSync(join(steps, runId))) {
      if (!file.endsWith(".json")) continue;
      const step = JSON.parse(readFileSync(join(steps, runId, file), "utf8")) as {
        status: string;
        stepId: string;
      };
      const key = `${runId}-${step.stepId}`;
      if (step.status === "running" || step.status === "pending" || !settled.has(key)) {
        unsettled += 1;
      }
    }
  }
  return unsettled;
}

/** Posts an empty delivery to the flow route, with `proof` as its delivery header when given. */
async function postDelivery(url: string, proof?: string): Promise<Response> {
  return await fetch(new URL("/.well-known/workflow/v1/flow", url), {
    body: "{}",
    headers: proof === undefined ? {} : { "x-eve-workflow-delivery": proof },
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
}

// The local queue is in memory, so the wait's timer died with the process.
// Only a recovery message tells a spec 9 run to arm it again.
it("finishes a spec 9 turn that was sleeping when `eve start` was killed", async () => {
  stubProductionEnv();
  const { appRoot } = app;
  await rm(resolveLocalWorkflowWorldDataDirectory(appRoot), { force: true, recursive: true });
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
    // The session's idle timeout and the sleep: the crash must lose a stored wait's timer.
    await expect
      .poll(() => countJournaledWaits(appRoot), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);
    // And only once every step is settled in the log: what the test kills is a sleeping turn,
    // not a step write.
    await expect.poll(() => countUnsettledSteps(appRoot), { timeout: 30_000 }).toBe(0);
  } finally {
    await server.crash();
  }
  // Every stored wait was still pending when the process died, so the
  // restarted server must arm their timers again.
  expect(readStoredWaits(appRoot).map((wait) => wait.status)).not.toContain("completed");

  server = await startPackagedEveStart(appRoot);
  try {
    // The built server refuses a delivery without its queue key, before eve checks its own
    // proof, which still guards anything that gets past it.
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
    // Its own deliveries carry the key, and its guard replays the run this build owns.
    expect(outcome, `The turn did not settle within 60s.\n${server.stderr()}`).toBe("completed");
    expect(server.stdout() + server.stderr()).not.toContain("Skipping replay of stranded session");
  } finally {
    await server.stop();
  }
}, 180_000);
