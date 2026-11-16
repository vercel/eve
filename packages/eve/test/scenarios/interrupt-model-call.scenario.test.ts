import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { Client } from "../../src/client/client.js";
import type { ClientSession } from "../../src/client/session.js";
import type { SessionStreamEvent } from "../../src/protocol/session-event.js";
import { buildApplication } from "../../src/internal/nitro/host.js";
import { materializeScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startPackagedEveStart, type RunningEveStart } from "./eve-start-harness.js";

const AUTH = { basic: { username: "alice", password: "fixture" } };
// Shorter than the 2 s the Workflow runtime waits between log polls when the World has no live
// event feed: an interrupt the runtime only learns of by polling arrives after the call finished.
const MODEL_CALL_MS = 1_500;
const INTERRUPT_AFTER_MS = 300;

// A turn's model call and tools run inside one inline Workflow step, which learns of a cancel or
// a steer only through the World (vercel/eve#6496). Only a built server on the local World runs
// that step the way `eve start` does.
let app: Awaited<ReturnType<typeof materializeScenarioApp>>;
let server: RunningEveStart | undefined;

beforeAll(async () => {
  vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "");
  vi.stubEnv("NODE_ENV", "production");
  try {
    app = await materializeScenarioApp({
      name: "interrupt-model-call",
      installDependencies: true,
      files: {
        // Every model call waits, honoring its abort signal, before the mock answers: Alice's
        // requests call `save`, and a steering message gets a plain reply.
        "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const model = mockModel((request) => {
  const message = request.lastUserMessage ?? "";
  if (message.startsWith("Instead")) return "Hello, Alice.";
  if (request.toolResults.length > 0) return "Saved.";
  return { toolCalls: [{ name: "save", input: { text: message } }] };
});
if (typeof model === "string" || model.specificationVersion !== "v4") {
  throw new Error("Expected a v4 mock model.");
}
const waitForModel = (signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ${MODEL_CALL_MS});
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
const generate = model.doGenerate.bind(model);
const stream = model.doStream.bind(model);
model.doGenerate = async (options) => {
  await waitForModel(options.abortSignal);
  return await generate(options);
};
model.doStream = async (options) => {
  await waitForModel(options.abortSignal);
  return await stream(options);
};

export default defineAgent({ model, modelContextWindowTokens: 32_000 });`,
        "agent/tools/save.ts": `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "eve/tools";
export default defineTool({
  description: "Save Alice's note.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute({ text }: { text: string }) {
    mkdirSync(join(process.cwd(), "saved"), { recursive: true });
    writeFileSync(join(process.cwd(), "saved", encodeURIComponent(text)), "");
    return "saved";
  },
});`,
        "agent/instructions.md": "Save Alice's notes.\n",
        "agent/channels/eve.ts": `import { httpBasic } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
export default eveChannel({ auth: httpBasic({ username: "alice", password: "fixture" }) });`,
      },
    });
    await buildApplication(app.appRoot, { skipSandboxPrewarm: true });
    server = await startPackagedEveStart(app.appRoot);
  } finally {
    vi.unstubAllEnvs();
  }
}, 180_000);

afterAll(async () => {
  await server?.stop();
  await app?.cleanup();
});

/**
 * Sends Alice's message, then interrupts the turn while its first model call waits, and returns
 * the events of the message's delivery.
 */
async function interruptModelCall(
  session: ClientSession,
  message: string,
  interrupt: (session: ClientSession) => Promise<unknown>,
): Promise<SessionStreamEvent[]> {
  const delivery = await session.send(message);
  const events: SessionStreamEvent[] = [];
  let interrupted: Promise<unknown> | undefined;
  for await (const event of delivery.stream({ signal: AbortSignal.timeout(30_000) })) {
    events.push(event);
    if (event.type === "model.started" && interrupted === undefined) {
      interrupted = sleep(INTERRUPT_AFTER_MS).then(async () => await interrupt(session));
    }
  }
  await interrupted;
  return events;
}

function savedNotes(): string[] {
  const saved = join(app.appRoot, "saved");
  return existsSync(saved) ? readdirSync(saved).map(decodeURIComponent) : [];
}

const MODES = [
  {
    mode: "cancel",
    interrupt: async (session: ClientSession) => await session.cancel(),
    stoppedCall: "interrupted",
    turnOutcome: "cancelled",
  },
  {
    mode: "steer",
    interrupt: async (session: ClientSession) =>
      await session.send("Instead, just say hello.", { turnPolicy: "steer" }),
    // A steered call settles without output, and the turn goes on with the new message.
    stoppedCall: "completed",
    turnOutcome: "completed",
  },
] as const;

// Broken until eve vendors a world-local with `events.subscribe` (vercel/workflow#5436): without a
// live feed, the inline step hears of the interrupt only at the runtime's next log poll.
it.fails.each(MODES)(
  "stops the model call a $mode interrupts on a session's first and second turns, before its tool runs",
  async ({ mode, interrupt, stoppedCall, turnOutcome }) => {
    const { session } = await new Client({ baseUrl: server!.url, auth: AUTH }).sessions.create();
    for (const turn of ["first", "second"]) {
      const note = `Alice's ${turn} ${mode} note`;
      const events = await interruptModelCall(session, note, interrupt);
      const settled = (type: string) =>
        events.flatMap((event) =>
          event.type === type ? [(event.data as { outcome?: string }).outcome] : [],
        );

      expect(settled("model.settled")[0], `${turn} turn`).toBe(stoppedCall);
      expect(settled("turn.settled")).toEqual([turnOutcome]);
      expect(events.some((event) => event.type === "call.requested")).toBe(false);
      expect(savedNotes()).not.toContain(note);
    }
  },
  60_000,
);
