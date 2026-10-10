import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { resolveLocalWorkflowWorldDataDirectory } from "../../src/internal/workflow/local-world-data-directory.js";
import { type RunningEveStart, startPackagedEveStart } from "./eve-start-harness.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 300_000;
const WAIT_TIMEOUT_MS = 60_000;

const STRANDED_SESSION_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(() => "Noted."),
  modelContextWindowTokens: 32_000,
});
`,
    "agent/instructions.md": "Acknowledge each message briefly.\n",
    "agent/channels/threads.ts": `import { defineChannel, GET, POST, SessionStrandedError } from "eve/channels";

export default defineChannel({
  routes: [
    POST("/threads/:threadId", async (request, { from, params }) => {
      const session = await from(params.threadId!).send(await request.text(), { auth: null });
      return Response.json({ sessionId: session.id });
    }),
    POST("/sessions/:sessionId", async (request, { attachSession, params }) => {
      try {
        await attachSession(params.sessionId!).send(await request.text(), { auth: null });
        return Response.json({ delivered: true });
      } catch (error) {
        if (!SessionStrandedError.is(error)) throw error;
        return Response.json(
          { eveVersion: error.owner.eveVersion, stranded: true },
          { status: 409 },
        );
      }
    }),
    GET("/sessions/:sessionId/stream", async (_request, { attachSession, params }) => {
      const events = await attachSession(params.sessionId!).getEventStream();
      const ndjson = events
        .pipeThrough(
          new TransformStream({
            transform(event, controller) {
              controller.enqueue(JSON.stringify(event) + "\\n");
            },
          }),
        )
        .pipeThrough(new TextEncoderStream());
      return new Response(ndjson, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      });
    }),
  ],
});
`,
  },
  installDependencies: true,
  name: "stranded-session-reset",
};

/** Fetches from the running app, attaching its output to any transport failure. */
async function request(server: RunningEveStart, path: string, init?: RequestInit) {
  try {
    return await fetch(new URL(path, server.url), init);
  } catch (error) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} failed.\n${server.stdout()}\n${server.stderr()}`,
      {
        cause: error,
      },
    );
  }
}

async function sendToThread(server: RunningEveStart, message: string): Promise<string> {
  const response = await request(server, "/threads/alice", { body: message, method: "POST" });
  const body = await response.text();
  expect(response.status, `${body}\n${server.stderr()}`).toBe(200);
  return (JSON.parse(body) as { sessionId: string }).sessionId;
}

/** Reads the session's event stream until its first turn has finished. */
async function waitForTurnCompleted(server: RunningEveStart, sessionId: string): Promise<void> {
  const response = await request(server, `/sessions/${sessionId}/stream`, {
    signal: AbortSignal.timeout(WAIT_TIMEOUT_MS),
  });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`Stream ended before the turn completed.\n${server.stderr()}`);
      buffered += value;
      if (buffered.includes('"type":"turn.completed"')) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function waitForOutput(server: RunningEveStart, text: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!server.stderr().includes(text) && !server.stdout().includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for "${text}".\n${server.stdout()}\n${server.stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The local World keeps each run's record, including its attributes, at `runs/<runId>.json`. */
function runFilePath(appRoot: string, runId: string): string {
  return join(resolveLocalWorkflowWorldDataDirectory(appRoot), "runs", `${runId}.json`);
}

async function readRun(
  path: string,
): Promise<{ attributes: Record<string, string>; status: string }> {
  return JSON.parse(await readFile(path, "utf8")) as {
    attributes: Record<string, string>;
    status: string;
  };
}

describe("stranded sessions across an eve upgrade", () => {
  it(
    "parks the old session at startup and resets it on its next channel message",
    async () => {
      const { buildApplication } = await import("../../src/internal/nitro/host.js");
      const { appRoot } = await scenarioApp(STRANDED_SESSION_DESCRIPTOR);
      await buildApplication(appRoot, { skipSandboxPrewarm: true });

      let server = await startPackagedEveStart(appRoot);
      let strandedSessionId: string;
      try {
        strandedSessionId = await sendToThread(server, "Alice opens the thread.");
        await waitForTurnCompleted(server, strandedSessionId);
      } finally {
        await server.stop();
      }

      // Simulate the first upgrade from a release that did not stamp owner versions.
      const runFile = runFilePath(appRoot, strandedSessionId);
      const parked = await readRun(runFile);
      expect(parked.status).toBe("running");
      delete parked.attributes["$eve.version"];
      await writeFile(runFile, JSON.stringify(parked));

      server = await startPackagedEveStart(appRoot);
      try {
        await waitForOutput(
          server,
          `Skipping replay of stranded session run "${strandedSessionId}"`,
        );

        const byId = await request(server, `/sessions/${strandedSessionId}`, {
          body: "Bob follows up on the old session.",
          method: "POST",
        });
        expect(byId.status, server.stderr()).toBe(409);
        // The parked run recorded no eve version, as on the first upgrade.
        await expect(byId.json()).resolves.toEqual({ stranded: true });

        const freshSessionId = await sendToThread(server, "Alice continues the thread.");
        expect(freshSessionId).not.toBe(strandedSessionId);
        await waitForTurnCompleted(server, freshSessionId);
        await waitForOutput(server, "Reset stranded session");
        await expect(readRun(runFile)).resolves.toMatchObject({ status: "cancelled" });
        expect(server.stdout() + server.stderr()).not.toContain("CORRUPTED_EVENT_LOG");
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
