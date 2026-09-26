import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { Client } from "#client/client.js";
import type { ClientSession } from "#client/session.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { type ScenarioAppDescriptor, useScenarioApp } from "#internal/testing/scenario-app.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

const scenarioApp = useScenarioApp();
const TIMEOUT_MS = 30_000;
const AUTH_TOKEN = "nested-input-scenario-token";
const ALICE_ANSWER = "alice-lantern-7319";
const BOB_ANSWER = "bob-comet-4826";

const parentAgent = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
const model = mockModel((request) => {
  const messages = request.messages.map((message) => message.text).join("\\n");
  if (request.userMessageCount === 2) {
    const result = request.toolResults.find((entry) => entry.id === "delegate-2");
    if (result) return "ROOT_FINISHED=" + result.output;
    const agentId = /<agent id="([^"]+)" name="remote-child"/.exec(messages)?.[1];
    if (!agentId) throw new Error("Missing retained child id");
    return { toolCalls: [{ id: "delegate-2", name: "delegate", input: { agentId } }] };
  }
  if (request.toolResults.some((result) => result.id === "delegate-1")) return "Child is working.";
  return { toolCalls: [{ id: "delegate-1", name: "delegate", input: {} }] };
});
export default defineAgent({ model, modelContextWindowTokens: 32_000 });
`;
const parentTool = `import { defineWorkflowTool } from "eve/tools";
export default defineWorkflowTool({
  description: "Delegate to the remote child.", execution: "background",
  inputSchema: { type: "object", properties: { agentId: { type: "string" } }, additionalProperties: false },
  async execute(input, ctx) {
    "use workflow";
    return await ctx.agent("remote-child", { ...(input.agentId ? { agentId: input.agentId } : {}), message: input.agentId ? "Report both task results." : "Complete the two tasks." });
  },
});
`;
const childChannel = `import { eveChannel } from "eve/channels/eve";
export default eveChannel({
  trustedForwarders: (forwarder) => forwarder.principalId === "input-parent",
  auth(request) {
    if (request.headers.get("authorization") !== "Bearer ${AUTH_TOKEN}") return null;
    return { attributes: {}, authenticator: "scenario-bearer", principalId: "input-parent", principalType: "service" };
  },
});
`;
const askTool = (person: string) => `import { defineWorkflowTool } from "eve/tools";
export default defineWorkflowTool({
  description: "Ask for ${person}'s word.", execution: "background",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    "use workflow";
    const answer = await ctx.ask({ prompt: "Word for ${person}?", allowFreeform: true, dismissible: false });
    return "${person.toUpperCase()}_TOOL=" + (answer.text ?? "NO_ANSWER");
  },
});
`;
const approvalTool = `import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
export default defineTool({
  description: "Approve Bob's action.", approval: always(),
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute() { return "BOB_TOOL=executed"; },
});
`;

function childAgent(mixed: boolean): string {
  const second = mixed ? "approve-bob" : "ask-bob";
  return `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
const model = mockModel((request) => {
  const text = request.messages.map((message) => message.text).join("\\n");
  const alice = text.includes("ALICE_TOOL=${ALICE_ANSWER}") || request.toolResults.some((result) => result.id === "ask-alice-1" && result.output === "ALICE_TOOL=${ALICE_ANSWER}");
  const bob = text.includes("BOB_TOOL=${mixed ? "executed" : BOB_ANSWER}") || request.toolResults.some((result) => result.id === "second-1" && result.output === "BOB_TOOL=${mixed ? "executed" : BOB_ANSWER}");
  if (alice && bob) return "CHILD_FINISHED=alice-ok,bob-ok";
  if (request.lastUserMessage?.includes("Report both task results.") === true) return "CHILD_FINISHED=" + (alice ? "alice-ok" : "alice-missing") + "," + (bob ? "bob-ok" : "bob-missing");
  if (request.toolResults.some((result) => result.id === "ask-alice-1")) return "Waiting for both tasks.";
  return { toolCalls: [
    { id: "ask-alice-1", name: "ask-alice", input: {} },
    { id: "second-1", name: "${second}", input: {} },
  ] };
});
export default defineAgent({ description: "Complete two independent tasks.", model, modelContextWindowTokens: 32_000 });
`;
}

function childDescriptor(mixed: boolean): ScenarioAppDescriptor {
  return {
    files: {
      "agent/agent.ts": childAgent(mixed),
      "agent/channels/eve.ts": childChannel,
      "agent/instructions.md": "Complete two independent tasks.\n",
      "agent/tools/ask-alice.ts": mixed
        ? askTool("Alice").replace('execution: "background",', "")
        : askTool("Alice"),
      [`agent/tools/${mixed ? "approve-bob" : "ask-bob"}.ts`]: mixed
        ? approvalTool
        : askTool("Bob"),
    },
    installDependencies: true,
    name: mixed ? "mixed-input-child" : "two-tools-child",
  };
}
function parentDescriptor(remoteUrl: string): ScenarioAppDescriptor {
  return {
    files: {
      "agent/agent.ts": parentAgent,
      "agent/channels/eve.ts": `import { none } from "eve/channels/auth";\nimport { eveChannel } from "eve/channels/eve";\nexport default eveChannel({ auth: none() });\n`,
      "agent/instructions.md": "Delegate two tasks.\n",
      "agent/tools/delegate.ts": parentTool,
      "agent/subagents/remote-child.ts": `import { defineRemoteAgent } from "eve";
import { bearer } from "eve/agents/auth";
export default defineRemoteAgent({ auth: bearer("${AUTH_TOKEN}"), description: "Complete two tasks.", url: ${JSON.stringify(remoteUrl)} });
`,
    },
    installDependencies: true,
    name: "nested-input-parent",
  };
}

const requests = (events: readonly HandleMessageStreamEvent[]) =>
  filterEventsByType(events, "input.requested").flatMap((event) => event.data.requests);

async function waitFor(input: {
  session: ClientSession;
  label: string;
  ready: (events: readonly HandleMessageStreamEvent[]) => boolean;
}): Promise<readonly HandleMessageStreamEvent[]> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let events: readonly HandleMessageStreamEvent[] = [];
  try {
    while (!signal.aborted) {
      ({ events } = await input.session.snapshot({ signal }));
      if (filterEventsByType(events, "session.failed").length > 0)
        throw new Error("Session failed");
      if (input.ready(events)) return events;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out");
  } catch (cause) {
    throw new Error(`Waiting for ${input.label}; last events: ${JSON.stringify(events)}`, {
      cause,
    });
  }
}

interface Server {
  url: string;
  stdout(): string;
  stderr(): string;
  stop(): Promise<void>;
}
async function startServer(root: string): Promise<Server> {
  const child = spawn(
    process.execPath,
    [
      join(root, "node_modules/eve/bin/eve.js"),
      "dev",
      "--no-ui",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ],
    {
      cwd: root,
      env: { ...process.env, EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Server startup timed out: ${stdout}\n${stderr}`));
      }, TIMEOUT_MS);
      function check() {
        const match = /\[DEV\] server listening at (http:\/\/[^\s]+)/u.exec(stdout);
        if (match?.[1] !== undefined) {
          cleanup();
          resolve(match[1]);
        }
      }
      function exited(code: number | null) {
        cleanup();
        reject(new Error(`Server exited ${code}: ${stdout}\n${stderr}`));
      }
      function cleanup() {
        clearTimeout(timeout);
        child.stdout.off("data", check);
        child.off("exit", exited);
      }
      child.stdout.on("data", check);
      child.once("exit", exited);
      check();
    });
    return { url, stdout: () => stdout, stderr: () => stderr, stop: () => stop(child) };
  } catch (error) {
    await stop(child);
    throw error;
  }
}
async function stop(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
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

async function exercise(mixed: boolean): Promise<void> {
  const childApp = await scenarioApp(childDescriptor(mixed));
  const childServer = await startServer(childApp.appRoot);
  try {
    const parentApp = await scenarioApp(parentDescriptor(childServer.url));
    const parentServer = await startServer(parentApp.appRoot);
    const parent = new Client({ host: parentServer.url });
    const child = new Client({ host: childServer.url, auth: { bearer: AUTH_TOKEN } });
    let rootSession: ClientSession | undefined;
    let remoteSession: ClientSession | undefined;
    try {
      const { session, response } = await parent.sessions.create({
        message: "Complete both tasks.",
      });
      rootSession = session;
      expect((await response.result()).status).toBe("waiting");
      const pending = await waitFor({
        session,
        label: "two independent root input requests",
        ready: (events) => requests(events).length >= 2,
      });
      const rootRequests = requests(pending);
      expect(rootRequests).toHaveLength(2);
      expect(rootRequests.map((request) => request.kind).sort()).toEqual(
        mixed ? ["question", "tool-approval"] : ["question", "question"],
      );
      expect(rootRequests.map((request) => request.prompt).sort()).toEqual(
        mixed
          ? ["Approve tool call: approve-bob", "Word for Alice?"]
          : ["Word for Alice?", "Word for Bob?"],
      );
      const call = filterEventsByType(pending, "subagent.called")[0];
      if (call?.data.childSessionId === undefined) throw new Error("Missing child session id");
      const childSession = child.sessions.attach(call.data.childSessionId);
      remoteSession = childSession;
      for (const [index, request] of rootRequests.entries()) {
        await session.respond([
          request.kind === "tool-approval"
            ? { requestId: request.requestId, optionId: "approve" }
            : {
                requestId: request.requestId,
                text: request.prompt.includes("Alice") ? ALICE_ANSWER : BOB_ANSWER,
              },
        ]);
        if (index === 0) {
          await waitFor({
            session: childSession,
            label: `older ${request.kind} operation to resume`,
            ready: (events) =>
              request.kind === "tool-approval"
                ? filterEventsByType(events, "action.result").some((event) =>
                    JSON.stringify(event.data).includes("BOB_TOOL=executed"),
                  )
                : filterEventsByType(events, "message.received").some((event) =>
                    event.data.message.includes(
                      request.prompt.includes("Alice")
                        ? `ALICE_TOOL=${ALICE_ANSWER}`
                        : `BOB_TOOL=${BOB_ANSWER}`,
                    ),
                  ),
          });
        }
      }
      await waitFor({
        session: childSession,
        label: "both distinct task results in child notifications",
        ready: (events) => {
          const notifications = filterEventsByType(events, "message.received")
            .map((event) => event.data.message)
            .join("\\n");
          return (
            notifications.includes(`ALICE_TOOL=${ALICE_ANSWER}`) &&
            notifications.includes(`BOB_TOOL=${mixed ? "executed" : BOB_ANSWER}`)
          );
        },
      });
      const followUp = await session.send("Ask the same child to report both task results.");
      expect((await followUp.result()).status).toBe("waiting");
      const final = await waitFor({
        session,
        label: "distinct child results at root",
        ready: (events) =>
          filterEventsByType(events, "message.completed").some(
            (event) => event.data.message === "ROOT_FINISHED=alice-ok,bob-ok",
          ),
      });
      expect(filterEventsByType(final, "session.failed")).toHaveLength(0);
      expect(
        filterEventsByType((await childSession.snapshot()).events, "message.completed").map(
          (event) => event.data.message,
        ),
      ).toContain("CHILD_FINISHED=alice-ok,bob-ok");
    } catch (error) {
      const summarize = async (session: ClientSession | undefined) =>
        session === undefined
          ? []
          : (await session.snapshot()).events
              .filter((event) =>
                [
                  "input.requested",
                  "message.received",
                  "action.result",
                  "message.completed",
                  "subagent.completed",
                  "session.failed",
                ].includes(event.type),
              )
              .map((event) => ({ type: event.type, data: event.data }));
      throw new Error(
        `root=${JSON.stringify(await summarize(rootSession))}\nchild=${JSON.stringify(await summarize(remoteSession))}\nparent stdout:\n${parentServer.stdout()}\nparent stderr:\n${parentServer.stderr()}\nchild stdout:\n${childServer.stdout()}\nchild stderr:\n${childServer.stderr()}`,
        { cause: error },
      );
    } finally {
      await parentServer.stop();
    }
  } finally {
    await childServer.stop();
  }
}

describe("nested input source ownership", () => {
  it(
    "keeps a harness-owned approval pending alongside a workflow question",
    () => exercise(true),
    360_000,
  );
  it(
    "answers two separate background workflow tools in one remote child",
    () => exercise(false),
    360_000,
  );
});
