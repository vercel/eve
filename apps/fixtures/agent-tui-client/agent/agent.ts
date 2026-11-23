import { setTimeout as sleep } from "node:timers/promises";

import { defineAgent, type DefinedAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

const CALL_TOOL = "eve__tool";
const TASK_WAIT_TOOL = "eve__task_wait";
const SLOW_REPLY_MS = 5_000;

/**
 * Scripted model for the TUI smoke tests in `packages/eve/test/tui-client`.
 * Each branch answers one smoke prompt, so the suite never calls a real model.
 */
async function respond(request: MockModelRequest): Promise<MockModelResponse | string> {
  const message = request.lastUserMessage ?? "";
  if (message.includes("echo marker subagent")) return delegateToEchoMarker(request);
  if (message.includes("ask_question")) return askForEnvironment(request);
  const note = /note: "([^"]+)"/u.exec(message)?.[1];
  if (note !== undefined) return callEchoMarker(request, note);
  const token = /containing the token (\S+?)\./u.exec(message)?.[1];
  if (token !== undefined) return `Here is the token ${token}.`;
  if (message.startsWith("Write a")) {
    await sleep(SLOW_REPLY_MS);
    return "The tide rose over the harbor wall and went out again at dawn.";
  }
  return `Mock reply: ${message}`;
}

function delegateToEchoMarker(request: MockModelRequest): MockModelResponse | string {
  const result = taskResultOf(request, "echo-marker");
  if (result !== undefined) return `The echo marker subagent returned: ${result}`;
  if (request.toolResults.some((entry) => entry.name === "echo-marker")) {
    return { toolCalls: [{ input: {}, name: TASK_WAIT_TOOL }] };
  }
  return { toolCalls: [{ input: { message: "ping" }, name: "echo-marker" }] };
}

function askForEnvironment(request: MockModelRequest): MockModelResponse | string {
  const result = request.toolResults.find((entry) => entry.name === "ask_question");
  if (result !== undefined) {
    const output = result.output as { answer?: string };
    return `You said: ${output.answer ?? JSON.stringify(result.output)}`;
  }
  return {
    toolCalls: [
      {
        input: {
          options: [
            { description: "Live traffic.", label: "Production" },
            { description: "Pre-release testing.", label: "Staging" },
            { description: "Per-branch builds.", label: "Preview" },
          ],
          question: "Which environment?",
        },
        name: "ask_question",
      },
    ],
  };
}

/**
 * Signs in to `stub-mcp-user`, then calls its `echo_marker` tool and replies with the output.
 * Sign-in drops the interrupted call from history, so the script makes it again as `<id>#<n>`.
 */
function callEchoMarker(request: MockModelRequest, note: string): MockModelResponse | string {
  const steps = [
    { id: `sign-in-${note}`, input: { name: "stub-mcp-user" } },
    { id: `echo-${note}`, input: { input: { note }, name: "stub-mcp-user__echo_marker" } },
  ];
  const scriptedId = (id: string) => id.replace(/#\d+$/u, "");
  const done = new Set(request.toolResults.map((entry) => scriptedId(entry.id)));
  const next = steps.find((step) => !done.has(step.id));
  if (next !== undefined) return { toolCalls: [{ ...next, name: CALL_TOOL }] };
  const echo = request.toolResults.find((entry) => scriptedId(entry.id) === `echo-${note}`);
  return typeof echo?.output === "string" ? echo.output : JSON.stringify(echo?.output);
}

/** A subagent call returns a receipt; its result arrives later in a `<task_result>` message. */
function taskResultOf(request: MockModelRequest, tool: string): string | undefined {
  const pattern = new RegExp(`<task_result [^>]*tool="${tool}"[^>]*>([\\s\\S]*?)</task_result>`);
  for (const message of [...request.messages].reverse()) {
    if (message.role !== "user") continue;
    const body = message.text.match(pattern)?.[1];
    if (body !== undefined) return body;
  }
  return undefined;
}

const agent: DefinedAgent = defineAgent({
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});

export default agent;
