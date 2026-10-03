import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { filterEventsByType } from "#internal/testing/events.js";
import { type ScenarioAppDescriptor, useScenarioApp } from "#internal/testing/scenario-app.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

const scenarioApp = useScenarioApp();
const EVENT_TIMEOUT_MS = 30_000;
const SCENARIO_TIMEOUT_MS = 360_000;

const ASK_QUESTION_APP: ScenarioAppDescriptor = {
  dependencies: { zod: "4.5.4" },
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const model = mockModel((request) => {
  if (request.toolResults.some((result) => result.name === "whoami")) return "Done.";
  if (request.toolResults.some((result) => result.name === "ask_question")) {
    return { toolCalls: [{ id: "whoami-call", input: {}, name: "whoami" }] };
  }
  return {
    toolCalls: [{
      id: "question-call",
      input: {
        options: [
          { description: "Assets and liabilities.", label: "Balance sheet" },
          { description: "Revenue and expenses.", label: "Income statement" },
        ],
        question: "Which report?",
      },
      name: "ask_question",
    }],
  };
});

export default defineAgent({ model, modelContextWindowTokens: 32_000 });
`,
    "agent/channels/eve.ts": `import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [async (request) => {
    const delivery = request.headers.get("x-repro-delivery");
    if (!delivery) return null;
    return {
      attributes: { delivery },
      authenticator: "scenario",
      principalId: "scenario-user",
      principalType: "user",
    };
  }],
});
`,
    "agent/instructions.md": "Run the deterministic ask_question lifecycle.\n",
    "agent/tools/ask_question.ts": `import { askQuestion } from "eve/tools/ask_question";

export default askQuestion();
`,
    "agent/tools/whoami.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Report the active delivery.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return { delivery: ctx.session.auth.current?.attributes.delivery ?? null };
  },
});
`,
  },
  installDependencies: true,
  name: "ask-question-answer-auth",
};

describe("ask_question answer delivery", () => {
  it(
    "starts a new turn and uses the answering delivery's auth for resumed tools",
    async () => {
      const app = await scenarioApp(ASK_QUESTION_APP);
      const server = await startEveDev(app.appRoot);

      try {
        const created = await fetch(new URL("/eve/v1/session", server.url), {
          body: JSON.stringify({ message: "Help me pick a report." }),
          headers: {
            "content-type": "application/json",
            "x-repro-delivery": "first-message",
          },
          method: "POST",
        });
        if (!created.ok) {
          throw new Error(`Session creation returned ${created.status}: ${await created.text()}`);
        }
        const createdBody = (await created.json()) as { sessionId: string };
        const first = await readUntilWait(server.url, createdBody.sessionId, 0, "first-message");
        const request = filterEventsByType(first, "input.requested")[0]?.data.requests[0];
        expect(request?.kind).toBe("question");
        if (request === undefined) throw new Error("Expected ask_question to request input.");

        const answered = await fetch(
          new URL(`/eve/v1/session/${createdBody.sessionId}`, server.url),
          {
            body: JSON.stringify({
              inputResponses: [{ optionId: "Balance sheet", requestId: request.requestId }],
            }),
            headers: {
              "content-type": "application/json",
              "x-repro-delivery": "answer",
            },
            method: "POST",
          },
        );
        expect(answered.ok).toBe(true);

        const resumed = await readUntilWait(
          server.url,
          createdBody.sessionId,
          first.length,
          "answer",
        );
        const turnStarts = filterEventsByType(resumed, "turn.started");
        const whoami = filterEventsByType(resumed, "action.result").find(
          (event) =>
            event.data.result.kind === "tool-result" && event.data.result.toolName === "whoami",
        );

        expect({
          resumedTurnStarts: turnStarts.map((event) => event.data.turnId),
          whoamiDelivery: whoami?.data.result.output,
          whoamiTurnId: whoami?.data.turnId,
        }).toMatchObject({
          resumedTurnStarts: [expect.stringMatching(/^turn_\d+$/u)],
          whoamiDelivery: { delivery: "answer" },
          whoamiTurnId: expect.stringMatching(/^turn_\d+$/u),
        });
      } catch (error) {
        throw new Error(
          [`stdout:\n${server.stdout()}`, `stderr:\n${server.stderr()}`].join("\n\n"),
          {
            cause: error,
          },
        );
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});

interface RunningEveDev {
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
  stop(): Promise<void>;
}

async function startEveDev(appRoot: string): Promise<RunningEveDev> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(
    process.execPath,
    [eveBinPath, "dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      env: { ...process.env, EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let url: string;
  try {
    url = await waitForServerUrl(child, () => ({ stderr, stdout }));
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return {
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      await stopChild(child);
    },
    url,
  };
}

async function waitForServerUrl(
  child: ChildProcessByStdio<null, Readable, Readable>,
  output: () => { readonly stderr: string; readonly stdout: string },
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      const current = output();
      reject(new Error(`Timed out waiting for eve dev.\n${current.stdout}\n${current.stderr}`));
    }, EVENT_TIMEOUT_MS);
    function inspect() {
      const url = /\[DEV\] server listening at (http:\/\/[^\s]+)/u.exec(output().stdout)?.[1];
      if (url !== undefined) {
        cleanup();
        resolve(url);
      }
    }
    function exited(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      const current = output();
      reject(
        new Error(
          [
            `eve dev exited before startup (code ${String(code)}, ${String(signal)}).`,
            `stdout:\n${current.stdout}`,
            `stderr:\n${current.stderr}`,
          ].join("\n\n"),
        ),
      );
    }
    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", inspect);
      child.stderr.off("data", inspect);
      child.off("exit", exited);
    }
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", exited);
    inspect();
  });
}

async function stopChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function readUntilWait(
  serverUrl: string,
  sessionId: string,
  startIndex: number,
  delivery: string,
): Promise<HandleMessageStreamEvent[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EVENT_TIMEOUT_MS);
  const response = await fetch(
    new URL(`/eve/v1/session/${sessionId}/stream?startIndex=${startIndex}`, serverUrl),
    { headers: { "x-repro-delivery": delivery }, signal: controller.signal },
  );
  if (!response.ok) throw new Error(`Session stream returned ${response.status}.`);

  const events: HandleMessageStreamEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of response.body!) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          const event = JSON.parse(line) as HandleMessageStreamEvent;
          events.push(event);
          if (event.type === "session.waiting") {
            controller.abort();
            return events;
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) throw error;
  } finally {
    clearTimeout(timeout);
  }
  return events;
}
