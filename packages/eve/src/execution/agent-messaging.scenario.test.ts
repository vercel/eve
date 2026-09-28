import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { type ScenarioAppDescriptor, useScenarioApp } from "#internal/testing/scenario-app.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  isAgentTurnSpan,
  listLocalTraces,
  type LocalTrace,
  type LocalTraceSpan,
} from "#tracing/local-trace-reader.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const EVENT_TIMEOUT_MS = 30_000;
const CODEWORD = "LANTERN-COMET-7319";
const PARENT_RESULT = `PARENT_RECALLED=${CODEWORD}`;
const REMOTE_MEMORY_TOKEN = "remote-memory-scenario-token";

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
        const { childSessionId, parentSessionId } = await runScriptedParentSession({
          serverUrl: server.url,
          subagentName: "memory-child",
        });
        await expectRetainedChildConversation({
          childSessionId,
          client: new Client({ host: server.url }),
          expectedCompletionCount: 0,
        });
        await expectLocalTraceLineage(app.appRoot, { childSessionId, parentSessionId });
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
    "continues one parked remote agent with its retained conversation",
    async () => {
      const remoteApp = await scenarioApp(REMOTE_MEMORY_AGENT_DESCRIPTOR);
      const remoteServer = await startScriptedEveDev(remoteApp.appRoot);

      try {
        const parentApp = await scenarioApp(createRemoteAgentMessagingDescriptor(remoteServer.url));
        const parentServer = await startScriptedEveDev(parentApp.appRoot);

        try {
          const { childSessionId } = await runScriptedParentSession({
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
}): Promise<{ readonly childSessionId: string; readonly parentSessionId: string }> {
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
  return { childSessionId, parentSessionId: parentSession.state.sessionId };
}

async function expectLocalTraceLineage(
  appRoot: string,
  input: { readonly childSessionId: string; readonly parentSessionId: string },
): Promise<void> {
  let traces: LocalTrace[] = [];
  await vi.waitFor(
    async () => {
      traces = (await listLocalTraces(appRoot)).filter((trace) =>
        trace.conversationIds.includes(input.parentSessionId),
      );
      expect(traces).toHaveLength(4);
      for (const runId of [input.parentSessionId, input.childSessionId]) {
        expect(
          traces.filter((trace) =>
            trace.spans.some(
              (span) => isAgentTurnSpan(span) && span.attributes["agent.run.id"] === runId,
            ),
          ),
        ).toHaveLength(2);
      }
    },
    { interval: 100, timeout: EVENT_TIMEOUT_MS },
  );

  const byRun = (runId: string) =>
    traces
      .filter((trace) =>
        trace.spans.some(
          (span) => isAgentTurnSpan(span) && span.attributes["agent.run.id"] === runId,
        ),
      )
      .toSorted(
        (left, right) =>
          Number(root(left).attributes["agent.turn.sequence"]) -
          Number(root(right).attributes["agent.turn.sequence"]),
      );
  const parents = byRun(input.parentSessionId);
  const children = byRun(input.childSessionId);

  expect(new Set(traces.map((trace) => trace.traceId)).size).toBe(4);
  for (const [runId, runTraces] of [
    [input.parentSessionId, parents],
    [input.childSessionId, children],
  ] as const) {
    expect(runTraces.map((trace) => root(trace).attributes["agent.turn.sequence"])).toEqual([0, 1]);
    for (const trace of runTraces) {
      const activation = root(trace);
      expect(activation.parentSpanId).toBeUndefined();
      expect(activation.attributes).toMatchObject({
        "agent.run.id": runId,
        "agent.turn.outcome": "completed",
        "gen_ai.conversation.id": input.parentSessionId,
        "gen_ai.operation.name": "invoke_agent",
      });
      expect(trace.spans.filter(isAgentTurnSpan)).toHaveLength(1);
      const reached = new Set<string>();
      const pending = [activation.spanId];
      while (pending.length > 0) {
        const parentId = pending.pop()!;
        if (reached.has(parentId)) continue;
        reached.add(parentId);
        pending.push(
          ...trace.spans
            .filter((span) => span.parentSpanId === parentId)
            .map((span) => span.spanId),
        );
      }
      expect(reached.size, `detached spans in ${runId} trace ${trace.traceId}`).toBe(
        trace.spans.length,
      );
      const steps = trace.spans.filter((span) => span.name === "agent.step");
      const models = trace.spans.filter((span) => span.name.startsWith("chat "));
      expect(steps.length).toBeGreaterThan(0);
      expect(models.length).toBeGreaterThan(0);
      expect(steps.every((span) => span.parentSpanId === activation.spanId)).toBe(true);
      expect(models.every((span) => steps.some((step) => step.spanId === span.parentSpanId))).toBe(
        true,
      );
    }
  }

  const caller = parents[0]!.spans.find(
    (span) =>
      span.attributes["agent.invocation.role"] === "caller" &&
      span.attributes["agent.action.name"] === "memory-child",
  );
  expect(caller).toBeDefined();
  expect(
    children[0]!.spans.filter((span) => span.attributes["agent.invocation.role"] === "caller"),
  ).toHaveLength(0);
  expect(root(children[0]!).attributes).toMatchObject({
    "agent.parent_call.id": caller!.attributes["agent.action.call_id"],
    "agent.parent_run.id": input.parentSessionId,
    "agent.run.type": "subagent",
  });
  expect(root(children[0]!).links).toEqual([
    {
      attributes: { "eve.link.type": "agent.dispatch" },
      spanId: caller!.spanId,
      traceId: caller!.traceId,
    },
  ]);
  expect(root(children[1]!).links).toEqual([]);
}

function root(trace: LocalTrace): LocalTraceSpan {
  const [activation] = trace.spans.filter(isAgentTurnSpan);
  if (activation === undefined) throw new Error(`No activation in trace ${trace.traceId}`);
  return activation;
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
        EVE_TRACES: "on",
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
