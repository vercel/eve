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
const SCENARIO_TIMEOUT_MS = 360_000;
const EVENT_TIMEOUT_MS = 30_000;
const CODEWORD = "LANTERN-COMET-7319";
const PARENT_RESULT = `PARENT_RECALLED=${CODEWORD}`;
const REMOTE_MEMORY_TOKEN = "remote-memory-scenario-token";
const HITL_ANSWER = "approved-by-parent";
const HITL_CHILD_RESULT = `CHILD_APPROVED=${HITL_ANSWER}-Alice,${HITL_ANSWER}-Bob`;
const HITL_PARENT_RESULT = `REMOTE_HITL_RESULT=${HITL_ANSWER}`;

function createScriptedParentAgentSource(subagentName: string): string {
  const agentIdPattern = `<agent id="([^"]+)" name="${subagentName}"(?: [^>]*)?>`;
  const toolName = "run-program";
  const firstProgram = `return ctx.agent(${JSON.stringify(subagentName)}, { message: ${JSON.stringify(`Remember the codeword ${CODEWORD}. Confirm that you stored it.`)} });`;
  const secondProgram = (agentIdExpression: string) =>
    `return ctx.agent(${JSON.stringify(subagentName)}, { agentId: ${agentIdExpression}, message: "What codeword did I ask you to remember? Reply with the codeword." });`;

  return `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const CODEWORD = ${JSON.stringify(CODEWORD)};
const SUBAGENT_NAME = ${JSON.stringify(subagentName)};
const AGENT_ID_PATTERN = new RegExp(${JSON.stringify(agentIdPattern)}, "u");

const model = mockModel((request) => {
  const firstResult = request.toolResults.find((result) => result.id === "memory-exchange-1");
  if (request.userMessageCount === 1) {
    if (firstResult !== undefined) return "FIRST_EXCHANGE_COMPLETE";
    return {
      toolCalls: [
        {
          id: "memory-exchange-1",
          input: { js: ${JSON.stringify(firstProgram)} },
          name: ${JSON.stringify(toolName)},
        },
      ],
    };
  }

  const secondResult = request.toolResults.find((result) => result.id === "memory-exchange-2");
  if (request.userMessageCount === 2) {
    if (secondResult !== undefined) {
      if (typeof secondResult.output !== "string") {
        throw new Error("Second child result was not text.");
      }
      return \`PARENT_RECALLED=\${secondResult.output}\`;
    }
    const agentsSnippet = request.messages.map((message) => message.text).join("\\n");
    const agentId = AGENT_ID_PATTERN.exec(agentsSnippet)?.[1];
    if (agentId === undefined) {
      throw new Error(\`Parent model did not receive a \${SUBAGENT_NAME} agent id.\`);
    }
    return {
      toolCalls: [
        {
          id: "memory-exchange-2",
          input: {
            js: ${JSON.stringify(secondProgram("__AGENT_ID__"))}.replace("__AGENT_ID__", JSON.stringify(agentId)),
          },
          name: ${JSON.stringify(toolName)},
        },
      ],
    };
  }

  throw new Error("Parent model received an unexpected conversation length.");
});
export default defineAgent({
  model,
  modelContextWindowTokens: 32_000,
});
`;
}

const EVE_CHANNEL_SOURCE = `import { none } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({ auth: none() });
`;

const AUTHENTICATED_EVE_CHANNEL_SOURCE = `import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth(request) {
    if (request.headers.get("authorization") !== "Bearer ${REMOTE_MEMORY_TOKEN}") return null;
    return {
      attributes: {},
      authenticator: "scenario-bearer",
      principalId: "remote-memory-parent",
      principalType: "service",
    };
  },
});
`;

const MEMORY_AGENT_SOURCE = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const CODEWORD = ${JSON.stringify(CODEWORD)};

const model = mockModel((request) => {
  if (request.userMessageCount === 1) {
    return request.lastUserMessage?.includes(CODEWORD) === true
      ? \`STORED=\${CODEWORD}\`
      : "FIRST_EXCHANGE_MISSING_CODEWORD";
  }

  if (request.userMessageCount === 2) {
    const retainedFirstExchange = request.userMessages[0]?.includes(CODEWORD) === true;
    const asksForCodeword = request.lastUserMessage?.includes("What codeword") === true;
    return retainedFirstExchange && asksForCodeword ? CODEWORD : "CONTEXT_LOST";
  }

  throw new Error("Child model received an unexpected conversation length.");
});

export default defineAgent({
  description: "Remember a fact and recall it in a later agent exchange.",
  model,
  modelContextWindowTokens: 32_000,
});
`;

function createWorkflowProgramToolSource(): string {
  return `import { workflow } from "eve/tools/workflow";

export default workflow({ maxSubagents: 2 });
`;
}

function createHitlParentAgentSource(): string {
  return `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const model = mockModel((request) => {
  const taskResult = request.messages.map((message) => message.text).join("\\n");
  if (taskResult.includes(${JSON.stringify(HITL_CHILD_RESULT)})) return ${JSON.stringify(HITL_PARENT_RESULT)};
  if (request.toolResults.some((entry) => entry.id === "remote-hitl-1")) return "Background child is working.";
  return {
    toolCalls: [{ id: "remote-hitl-1", name: "delegate-approval", input: {} }],
  };
});

export default defineAgent({ model, modelContextWindowTokens: 32_000 });
`;
}

const HITL_PARENT_TOOL_SOURCE = `import { defineWorkflowTool } from "eve/tools";

export default defineWorkflowTool({
  description: "Delegate approval to the remote child.",
  execution: "background",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    "use workflow";
    return await ctx.agent("remote-hitl-child", { message: "Ask the parent for approval." });
  },
});
`;

const HITL_CHILD_AGENT_SOURCE = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const model = mockModel((request) => {
  const result = request.toolResults.find((entry) => entry.id === "ask-parent-1");
  if (result !== undefined) return "CHILD_APPROVED=" + result.output;
  return { toolCalls: [{ id: "ask-parent-1", name: "ask-parent", input: {} }] };
});

export default defineAgent({ model, modelContextWindowTokens: 32_000 });
`;

const HITL_TOOL_SOURCE = `import { defineWorkflowTool } from "eve/tools";

export default defineWorkflowTool({
  description: "Ask the parent for approval.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "string" },
  async execute(_input, ctx) {
    "use workflow";
    const answers = await Promise.all(["Alice", "Bob"].map((person) => ctx.ask({
      prompt: "What is the approval word for " + person + "?",
      dismissible: false,
      allowFreeform: true,
    })));
    return answers.map((answer) => answer.text ?? answer.optionId ?? "NO_ANSWER").join(",");
  },
});
`;

const REMOTE_HITL_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": HITL_CHILD_AGENT_SOURCE,
    "agent/channels/eve.ts": AUTHENTICATED_EVE_CHANNEL_SOURCE.replace(
      "  auth(request) {",
      "  trustedForwarders: (forwarder) => forwarder.principalId === 'remote-memory-parent',\n  auth(request) {",
    ),
    "agent/instructions.md": "Ask the parent for approval.\n",
    "agent/tools/ask-parent.ts": HITL_TOOL_SOURCE,
  },
  installDependencies: true,
  name: "remote-hitl-agent",
};

function createRemoteHitlParentDescriptor(remoteUrl: string): ScenarioAppDescriptor {
  return {
    files: {
      "agent/agent.ts": createHitlParentAgentSource(),
      "agent/channels/eve.ts": EVE_CHANNEL_SOURCE,
      "agent/instructions.md": "Delegate the approval question.\n",
      "agent/tools/delegate-approval.ts": HITL_PARENT_TOOL_SOURCE,
      "agent/subagents/remote-hitl-child.ts": `import { defineRemoteAgent } from "eve";
import { bearer } from "eve/agents/auth";

export default defineRemoteAgent({
  auth: bearer(${JSON.stringify(REMOTE_MEMORY_TOKEN)}),
  description: "Ask the parent for approval.",
  url: ${JSON.stringify(remoteUrl)},
});
`,
    },
    installDependencies: true,
    name: "remote-hitl-parent",
  };
}

const AGENT_MESSAGING_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": createScriptedParentAgentSource("memory-child"),
    "agent/channels/eve.ts": EVE_CHANNEL_SOURCE,
    "agent/instructions.md": "Run the scripted memory-child exchanges.\n",
    "agent/tools/run-program.ts": createWorkflowProgramToolSource(),
    "agent/subagents/memory-child/agent.ts": MEMORY_AGENT_SOURCE,
    "agent/subagents/memory-child/instructions.md":
      "Remember facts from earlier turns and answer follow-up questions from that history.\n",
  },
  installDependencies: true,
  name: "agent-messaging",
};

const REMOTE_MEMORY_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": MEMORY_AGENT_SOURCE,
    "agent/channels/eve.ts": AUTHENTICATED_EVE_CHANNEL_SOURCE,
    "agent/instructions.md":
      "Remember facts from earlier turns and answer follow-up questions from that history.\n",
  },
  installDependencies: true,
  name: "remote-memory-agent",
};

function createRemoteAgentMessagingDescriptor(remoteUrl: string): ScenarioAppDescriptor {
  return {
    files: {
      "agent/agent.ts": createScriptedParentAgentSource("remote-memory-child"),
      "agent/channels/eve.ts": EVE_CHANNEL_SOURCE,
      "agent/instructions.md": "Run the scripted remote-memory-child exchanges.\n",
      "agent/tools/run-program.ts": createWorkflowProgramToolSource(),
      "agent/subagents/remote-memory-child.ts": `import { defineRemoteAgent } from "eve";
import { bearer } from "eve/agents/auth";

export default defineRemoteAgent({
  auth: bearer(${JSON.stringify(REMOTE_MEMORY_TOKEN)}),
  description: "Remember a fact and recall it in a later agent exchange.",
  url: ${JSON.stringify(remoteUrl)},
});
`,
    },
    installDependencies: true,
    name: "remote-agent-messaging",
  };
}

describe("agent messaging", () => {
  it(
    "continues one parked child with its retained conversation and terminates it with the parent",
    async () => {
      const app = await scenarioApp(AGENT_MESSAGING_DESCRIPTOR);
      const server = await startScriptedEveDev(app.appRoot);

      try {
        const childSessionId = await runScriptedParentSession({
          serverUrl: server.url,
          subagentName: "memory-child",
        });
        await expectRetainedChildConversation({
          childSessionId,
          client: new Client({ host: server.url }),
          expectedCompletionCount: 0,
        });
      } catch (error) {
        throw new Error(
          [`stdout:\n${server.stdout()}`, `stderr:\n${server.stderr()}`].join("\n\n"),
          { cause: error },
        );
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "proxies HITL from concurrent remote workflow questions to an input-capable parent",
    async () => {
      const remoteApp = await scenarioApp(REMOTE_HITL_AGENT_DESCRIPTOR);
      const remoteServer = await startScriptedEveDev(remoteApp.appRoot);

      try {
        const parentApp = await scenarioApp(createRemoteHitlParentDescriptor(remoteServer.url));
        const parentServer = await startScriptedEveDev(parentApp.appRoot);

        try {
          const client = new Client({ host: parentServer.url });
          const { session: parentSession, response } = await client.sessions.create({
            message: "Delegate the approval question to the remote child.",
          });
          const firstTurn = await response.result();
          expect(firstTurn.status).toBe("waiting");
          expect(firstTurn.message).toContain("working");

          const parentEvents = await waitForParentEvents({
            session: parentSession,
            label: "both proxied questions",
            ready: (events) => filterEventsByType(events, "input.requested").length === 2,
          });
          const inputRequests = filterEventsByType(parentEvents, "input.requested");

          expect(inputRequests).toHaveLength(2);
          const requests = inputRequests.flatMap((event) => event.data.requests);
          expect(requests.map((request) => request.prompt).sort()).toEqual([
            "What is the approval word for Alice?",
            "What is the approval word for Bob?",
          ]);

          expect(indexesOf(parentEvents, "session.waiting")[0]).toBeLessThan(
            indexesOf(parentEvents, "input.requested")[0]!,
          );
          // Both sources must remain routable after the newer question arrives.
          for (const request of requests) {
            const person = request.prompt.includes("Alice") ? "Alice" : "Bob";
            await parentSession.respond([
              { requestId: request.requestId, text: `${HITL_ANSWER}-${person}` },
            ]);
          }

          // Background completion is a later notification, not the answer delivery's boundary.
          const finalEvents = await waitForParentEvents({
            session: parentSession,
            label: "child result on parent",
            ready: (events) =>
              filterEventsByType(events, "message.completed").some(
                (event) => event.data.message === HITL_PARENT_RESULT,
              ),
          });
          expect(filterEventsByType(finalEvents, "session.failed")).toHaveLength(0);
          const calls = filterEventsByType(finalEvents, "subagent.called");
          expect(calls).toHaveLength(1);
          const childSessionId = calls[0]?.data.childSessionId;
          if (childSessionId === undefined) throw new Error("Missing child session id.");
          const remoteClient = new Client({
            host: remoteServer.url,
            auth: { bearer: REMOTE_MEMORY_TOKEN },
          });
          const childSnapshot = await remoteClient.sessions.attach(childSessionId).snapshot();
          expect(
            filterEventsByType(childSnapshot.events, "message.completed").map(
              (event) => event.data.message,
            ),
          ).toContain(HITL_CHILD_RESULT);
          expect(filterEventsByType(childSnapshot.events, "session.failed")).toHaveLength(0);
        } catch (error) {
          throw new Error(
            [
              `parent stdout:\n${parentServer.stdout()}`,
              `parent stderr:\n${parentServer.stderr()}`,
              `remote stdout:\n${remoteServer.stdout()}`,
              `remote stderr:\n${remoteServer.stderr()}`,
            ].join("\n\n"),
            { cause: error },
          );
        } finally {
          await parentServer.stop();
        }
      } finally {
        await remoteServer.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "continues one parked remote agent with its retained conversation",
    async () => {
      const remoteApp = await scenarioApp(REMOTE_MEMORY_AGENT_DESCRIPTOR);
      const remoteServer = await startScriptedEveDev(remoteApp.appRoot);

      try {
        const parentApp = await scenarioApp(createRemoteAgentMessagingDescriptor(remoteServer.url));
        const parentServer = await startScriptedEveDev(parentApp.appRoot);

        try {
          const childSessionId = await runScriptedParentSession({
            expectedRemoteUrl: remoteServer.url,
            serverUrl: parentServer.url,
            subagentName: "remote-memory-child",
          });
          await expectRetainedChildConversation({
            childSessionId,
            client: new Client({
              auth: { bearer: REMOTE_MEMORY_TOKEN },
              host: remoteServer.url,
            }),
            expectedCompletionCount: 0,
          });
        } catch (error) {
          throw new Error(
            [
              `parent stdout:\n${parentServer.stdout()}`,
              `parent stderr:\n${parentServer.stderr()}`,
              `remote stdout:\n${remoteServer.stdout()}`,
              `remote stderr:\n${remoteServer.stderr()}`,
            ].join("\n\n"),
            { cause: error },
          );
        } finally {
          await parentServer.stop();
        }
      } finally {
        await remoteServer.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});

async function runScriptedParentSession(input: {
  readonly expectedRemoteUrl?: string;
  readonly serverUrl: string;
  readonly subagentName: string;
}): Promise<string> {
  const client = new Client({ host: input.serverUrl });
  const { session: parentSession, response: firstResponse } = await client.sessions.create({
    message: `Run both scripted ${input.subagentName} exchanges.`,
  });
  const firstTurn = await firstResponse.result();
  const firstTurnEvents = firstTurn.events;
  const secondTurn = await (
    await parentSession.send("Continue the same child and report its recalled codeword.")
  ).result();
  const parentEvents = [...firstTurnEvents, ...secondTurn.events];
  const calls = filterEventsByType(parentEvents, "subagent.called");

  if (calls.length !== 2) {
    throw new Error(`Expected two subagent calls. Parent events: ${JSON.stringify(parentEvents)}`);
  }
  expect(calls.map((call) => call.data.name)).toEqual([input.subagentName, input.subagentName]);
  expect(calls[0]?.data.childSessionId).toBeDefined();
  expect(calls[1]?.data.childSessionId).toBe(calls[0]?.data.childSessionId);
  if (input.expectedRemoteUrl === undefined) {
    expect(calls.every((call) => call.data.remote === undefined)).toBe(true);
  } else {
    expect(calls.map((call) => call.data.remote?.url)).toEqual([
      input.expectedRemoteUrl,
      input.expectedRemoteUrl,
    ]);
  }
  expect(secondTurn.status).toBe("waiting");
  expect(secondTurn.message).toBe(PARENT_RESULT);

  const childSessionId = calls[0]?.data.childSessionId;
  if (childSessionId === undefined) {
    throw new Error("First subagent.called event did not include a child session id.");
  }
  return childSessionId;
}

async function expectRetainedChildConversation(input: {
  readonly childSessionId: string;
  readonly client: Client;
  readonly expectedCompletionCount: number;
}): Promise<void> {
  const childEvents = await collectStreamToEnd({
    label: "persisted child events",
    stream: input.client.sessions.attach(input.childSessionId).stream({ follow: false }),
  });
  const childTurnStarts = indexesOf(childEvents, "turn.started");
  const childWaits = indexesOf(childEvents, "session.waiting");

  expect(childTurnStarts).toHaveLength(2);
  expect(childWaits).toHaveLength(2);
  expect(childWaits[0]).toBeLessThan(childTurnStarts[1] ?? -1);
  expect(filterEventsByType(childEvents, "session.completed")).toHaveLength(
    input.expectedCompletionCount,
  );
  expect(filterEventsByType(childEvents, "session.failed")).toHaveLength(0);
  expect(
    filterEventsByType(childEvents, "message.completed").some(
      (event) => event.data.message === CODEWORD,
    ),
  ).toBe(true);
}

async function waitForParentEvents(input: {
  readonly session: ClientSession;
  readonly label: string;
  readonly ready: (events: readonly HandleMessageStreamEvent[]) => boolean;
}): Promise<readonly HandleMessageStreamEvent[]> {
  const signal = AbortSignal.timeout(EVENT_TIMEOUT_MS);
  let events: readonly HandleMessageStreamEvent[] = [];
  try {
    while (!signal.aborted) {
      ({ events } = await input.session.snapshot({ signal }));
      if (filterEventsByType(events, "session.failed").length > 0) {
        throw new Error("Parent session failed.");
      }
      if (input.ready(events)) return events;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out.");
  } catch (cause) {
    throw new Error(`Waiting for ${input.label}: ${JSON.stringify(events)}`, { cause });
  }
}

async function collectStreamToEnd(input: {
  readonly label: string;
  readonly stream: AsyncIterable<HandleMessageStreamEvent>;
}): Promise<readonly HandleMessageStreamEvent[]> {
  const events: HandleMessageStreamEvent[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      (async () => {
        for await (const event of input.stream) {
          events.push(event);
        }
        return events;
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${input.label}.`)),
          EVENT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function indexesOf(
  events: readonly HandleMessageStreamEvent[],
  type: HandleMessageStreamEvent["type"],
): readonly number[] {
  return events.flatMap((event, index) => (event.type === type ? [index] : []));
}

interface RunningScriptedEveDev {
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
  stop(): Promise<void>;
}

async function startScriptedEveDev(appRoot: string): Promise<RunningScriptedEveDev> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(
    process.execPath,
    [eveBinPath, "dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        EVE_MOCK_AUTHORED_MODELS: "",
        NODE_ENV: "production",
      },
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
      reject(
        new Error(
          `Timed out waiting for eve dev.\n\nstdout:\n${current.stdout}\n\nstderr:\n${current.stderr}`,
        ),
      );
    }, EVENT_TIMEOUT_MS);

    function inspect() {
      const match = /\[DEV\] server listening at (http:\/\/[^\s]+)/u.exec(output().stdout);
      if (match?.[1] === undefined) {
        return;
      }
      cleanup();
      resolve(match[1]);
    }

    function exited(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      const current = output();
      reject(
        new Error(
          [
            `eve dev exited before startup (code ${String(code)}, signal ${String(signal)}).`,
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
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
