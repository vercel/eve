import { spawn } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Client } from "#client/client.js";
import type { ClientSession } from "#client/session.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { type ScenarioAppDescriptor, useScenarioApp } from "#internal/testing/scenario-app.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";

const scenarioApp = useScenarioApp();
const TOKEN = "remote-input-scenario-token";
const ANSWER = "approved-by-parent";
const CHILD_RESULT = `CHILD_APPROVED=${ANSWER}`;
const PARENT_RESULT = `REMOTE_HITL_RESULT=${ANSWER}`;
const TIMEOUT = 120_000;

const channel = `import { none } from "eve/channels/auth"; import { eveChannel } from "eve/channels/eve"; export default eveChannel({ auth: none() });`;
const remoteChannel = `import { eveChannel } from "eve/channels/eve"; export default eveChannel({ trustedForwarders: (f) => f.principalId === "remote-parent", auth(request) { if (request.headers.get("authorization") !== "Bearer ${TOKEN}") return null; return { attributes: {}, authenticator: "scenario", principalId: "remote-parent", principalType: "service" }; } });`;

const childTool = `import { defineWorkflowTool } from "eve/tools";
export default defineWorkflowTool({ description: "Ask the parent.", inputSchema: {}, async execute(_input, ctx) { "use workflow"; const answer = await ctx.ask({ prompt: "What is the approval word?", allowFreeform: true }); return answer.text ?? answer.optionId ?? "NO_ANSWER"; } });`;
const childAgent = `import { defineAgent } from "eve"; import { mockModel } from "eve/evals";
const model = mockModel((request) => { const result = request.toolResults.find((entry) => entry.id === "ask-parent"); if (result) return "${CHILD_RESULT}".replace("${ANSWER}", String(result.output)); return { toolCalls: [{ id: "ask-parent", name: "ask-parent", input: {} }] }; });
export default defineAgent({ model, modelContextWindowTokens: 32000 });`;
const concurrentChildAgent = `import { defineAgent } from "eve"; import { mockModel } from "eve/evals";
const model = mockModel((request) => {
  const results = request.toolResults;
  if (results.some((entry) => entry.id === "ask-alice" && entry.output === "alice-lantern") &&
      results.some((entry) => entry.id === "ask-bob" && entry.output === "bob-comet")) return "CHILD_APPROVED=alice-lantern,bob-comet";
  if (results.some((entry) => entry.id === "ask-alice" || entry.id === "ask-bob")) return "Waiting for both approvals.";
  return { toolCalls: [{ id: "ask-alice", name: "ask-alice", input: {} }, { id: "ask-bob", name: "ask-bob", input: {} }] };
});
export default defineAgent({ model, modelContextWindowTokens: 32000 });`;
const askTool = (person: string) => `import { defineWorkflowTool } from "eve/tools";
export default defineWorkflowTool({ description: "Ask for ${person}'s approval word.", inputSchema: {}, async execute(_input, ctx) { "use workflow"; const answer = await ctx.ask({ prompt: "Word for ${person}?", allowFreeform: true }); return answer.text ?? "NO_ANSWER"; } });`;

const childDescriptor: ScenarioAppDescriptor = {
  name: "remote-input-child",
  installDependencies: true,
  files: {
    "agent/agent.ts": childAgent,
    "agent/channels/eve.ts": remoteChannel,
    "agent/instructions.md": "Ask the parent for approval.",
    "agent/tools/ask-parent.ts": childTool,
  },
};

const memoryChildDescriptor: ScenarioAppDescriptor = {
  name: "remote-memory-child",
  installDependencies: true,
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve"; import { mockModel } from "eve/evals";
const model = mockModel((request) => {
  if (request.userMessageCount === 1) return request.lastUserMessage?.includes("LANTERN-COMET-7319") ? "STORED" : "MISSING_CODEWORD";
  if (request.userMessageCount === 2) return request.userMessages[0]?.includes("LANTERN-COMET-7319") ? "LANTERN-COMET-7319" : "CONTEXT_LOST";
  return "UNEXPECTED_TURN";
});
export default defineAgent({ model, modelContextWindowTokens: 32000 });`,
    "agent/channels/eve.ts": remoteChannel,
    "agent/instructions.md": "Remember the first message for the follow-up.",
  },
};

const concurrentChildDescriptor: ScenarioAppDescriptor = {
  name: "remote-input-concurrent-child",
  installDependencies: true,
  files: {
    "agent/agent.ts": concurrentChildAgent,
    "agent/channels/eve.ts": remoteChannel,
    "agent/instructions.md": "Ask Alice and Bob for their words.",
    "agent/tools/ask-alice.ts": askTool("Alice"),
    "agent/tools/ask-bob.ts": askTool("Bob"),
  },
};

function parentDescriptor(url: string, concurrent = false): ScenarioAppDescriptor {
  const expectedChildResult = concurrent ? "CHILD_APPROVED=alice-lantern,bob-comet" : CHILD_RESULT;
  const expectedParentResult = concurrent
    ? "REMOTE_HITL_RESULT=alice-lantern,bob-comet"
    : PARENT_RESULT;
  const parentAgent = `import { defineAgent } from "eve"; import { mockModel } from "eve/evals";
const model = mockModel((request) => { const text = request.messages.map((m) => m.text).join("\\n"); if (text.includes("<task_result") && text.includes("${expectedChildResult}")) return "${expectedParentResult}"; if (request.toolResults.some((r) => r.id === "delegate")) return { toolCalls: [{ id: "wait", name: "${TASK_WAIT_TOOL_NAME}", input: {} }] }; return { toolCalls: [{ id: "delegate", name: "delegate-approval", input: {} }] }; });
export default defineAgent({ model, modelContextWindowTokens: 32000 });`;
  const tool = `import { defineWorkflowTool } from "eve/tools";
export default defineWorkflowTool({ description: "Delegate approval.", inputSchema: {}, async task(_input, ctx) { "use workflow"; const result = await ctx.agent("remote-hitl-child").send("Ask the parent for approval."); return (await result.result()).message; } });`;
  const remote = `import { defineRemoteAgent } from "eve"; import { bearer } from "eve/agents/auth"; export default defineRemoteAgent({ auth: bearer(${JSON.stringify(TOKEN)}), description: "Ask parent", url: ${JSON.stringify(url)} });`;
  return {
    name: "remote-input-parent",
    installDependencies: true,
    files: {
      "agent/agent.ts": parentAgent,
      "agent/channels/eve.ts": channel,
      "agent/instructions.md": "Delegate the approval question.",
      "agent/tools/delegate-approval.ts": tool,
      "agent/subagents/remote-hitl-child.ts": remote,
    },
  };
}

function memoryParentDescriptor(url: string): ScenarioAppDescriptor {
  const parentAgent = `import { defineAgent } from "eve"; import { mockModel } from "eve/evals";
const model = mockModel((request) => {
  const text = request.messages.map((message) => message.text).join("\\n");
  if (text.includes("MEMORY_RECALLED=LANTERN-COMET-7319")) return "PARENT_RECALLED=LANTERN-COMET-7319";
  if (text.includes("MEMORY_RECALLED=CONTEXT_LOST")) return "PARENT_RECALLED=CONTEXT_LOST";
  if (request.toolResults.some((result) => result.id === "remember")) return { toolCalls: [{ id: "wait-memory", name: "${TASK_WAIT_TOOL_NAME}", input: {} }] };
  return { toolCalls: [{ id: "remember", name: "remember", input: {} }] };
});
export default defineAgent({ model, modelContextWindowTokens: 32000 });`;
  const tool = `import { defineWorkflowTool } from "eve/tools";
export default defineWorkflowTool({ description: "Remember and recall a codeword in one remote session.", inputSchema: {}, async task(_input, ctx) { "use workflow";
  const agent = ctx.agent("remote-memory-child");
  const first = await (await agent.send("Remember the codeword LANTERN-COMET-7319.")).result();
  if (first.message !== "STORED") return "MEMORY_FIRST_FAILED=" + first.message;
  const second = await (await agent.send("What codeword did I ask you to remember?")).result();
  return "MEMORY_RECALLED=" + second.message;
} });`;
  const remote = `import { defineRemoteAgent } from "eve"; import { bearer } from "eve/agents/auth"; export default defineRemoteAgent({ auth: bearer(${JSON.stringify(TOKEN)}), description: "Remember a codeword", url: ${JSON.stringify(url)} });`;
  return {
    name: "remote-memory-parent",
    installDependencies: true,
    files: {
      "agent/agent.ts": parentAgent,
      "agent/channels/eve.ts": channel,
      "agent/instructions.md": "Ask the remote child to remember and recall a codeword.",
      "agent/tools/remember.ts": tool,
      "agent/subagents/remote-memory-child.ts": remote,
    },
  };
}

interface RunningServer {
  readonly url: string;
  readonly stdout: () => string;
  readonly stderr: () => string;
  stop(): Promise<void>;
}

it(
  "forwards one remote child HITL question to the root parent",
  async () => {
    const child = await scenarioApp(childDescriptor);
    const childServer = await startScriptedEveDev(child.appRoot);
    let parentServer: RunningServer | undefined;
    try {
      const parent = await scenarioApp(parentDescriptor(childServer.url));
      parentServer = await startScriptedEveDev(parent.appRoot);
      const client = new Client({ host: parentServer.url });
      const { session, response } = await client.sessions.create({
        message: "Delegate the approval question.",
      });
      const waiting = await response.result();
      expect(waiting.status).toBe("waiting");
      const events = await waitFor(
        session,
        (es) =>
          filterEventsByType(es, "input.requested").length === 1 ||
          filterEventsByType(es, "session.failed").length > 0,
      );
      expect(filterEventsByType(events, "session.failed")).toHaveLength(0);
      const request = filterEventsByType(events, "input.requested")[0]!.data.requests[0]!;
      expect(request.prompt).toBe("What is the approval word?");
      await session.respond([{ requestId: request.requestId, text: ANSWER }]);
      const final = await waitFor(
        session,
        (es) =>
          filterEventsByType(es, "message.completed").some(
            (e) => e.data.message === PARENT_RESULT,
          ) || filterEventsByType(es, "session.failed").length > 0,
      );
      expect(filterEventsByType(final, "session.failed")).toHaveLength(0);
      expect(filterEventsByType(final, "message.completed").map((e) => e.data.message)).toContain(
        PARENT_RESULT,
      );
    } catch (error) {
      throw new Error(
        `parent stdout:\n${parentServer?.stdout() ?? "not started"}\nparent stderr:\n${parentServer?.stderr() ?? "not started"}\nchild stdout:\n${childServer.stdout()}\nchild stderr:\n${childServer.stderr()}`,
        { cause: error },
      );
    } finally {
      await parentServer?.stop();
      await childServer.stop();
    }
  },
  TIMEOUT,
);

it(
  "answers two independent remote workflow questions without losing either request",
  async () => {
    const child = await scenarioApp(concurrentChildDescriptor);
    const childServer = await startScriptedEveDev(child.appRoot);
    let parentServer: RunningServer | undefined;
    try {
      const parent = await scenarioApp(parentDescriptor(childServer.url, true));
      parentServer = await startScriptedEveDev(parent.appRoot);
      const { session, response } = await new Client({ host: parentServer.url }).sessions.create({
        message: "Delegate the approval questions for Alice and Bob.",
      });
      expect((await response.result()).status).toBe("waiting");
      const pending = await waitFor(
        session,
        (events) =>
          filterEventsByType(events, "input.requested").flatMap((event) => event.data.requests)
            .length >= 2,
      );
      const requests = filterEventsByType(pending, "input.requested").flatMap(
        (event) => event.data.requests,
      );
      expect(requests.map((request) => request.prompt).sort()).toEqual([
        "Word for Alice?",
        "Word for Bob?",
      ]);
      const alice = requests.find((request) => request.prompt.includes("Alice"))!;
      const bob = requests.find((request) => request.prompt.includes("Bob"))!;
      const first = await session.respond([{ requestId: alice.requestId, text: "alice-lantern" }]);
      expect((await first.result()).status).toBe("waiting");
      const afterFirst = await session.snapshot();
      expect(
        filterEventsByType(afterFirst.events, "input.resolved")
          .flatMap((event) => event.data.resolutions)
          .some((resolution) => resolution.requestId === bob.requestId),
      ).toBe(false);
      await session.respond([{ requestId: bob.requestId, text: "bob-comet" }]);
      const final = await waitFor(session, (events) =>
        filterEventsByType(events, "message.completed").some(
          (event) => event.data.message === "REMOTE_HITL_RESULT=alice-lantern,bob-comet",
        ),
      );
      expect(filterEventsByType(final, "session.failed")).toHaveLength(0);
    } catch (error) {
      throw new Error(
        `parent stdout:\n${parentServer?.stdout() ?? "not started"}\nparent stderr:\n${parentServer?.stderr() ?? "not started"}\nchild stdout:\n${childServer.stdout()}\nchild stderr:\n${childServer.stderr()}`,
        { cause: error },
      );
    } finally {
      await parentServer?.stop();
      await childServer.stop();
    }
  },
  TIMEOUT,
);

it(
  "continues a parked remote child with its earlier conversation",
  async () => {
    const child = await scenarioApp(memoryChildDescriptor);
    const childServer = await startScriptedEveDev(child.appRoot);
    let parentServer: RunningServer | undefined;
    try {
      const parent = await scenarioApp(memoryParentDescriptor(childServer.url));
      parentServer = await startScriptedEveDev(parent.appRoot);
      const { session, response } = await new Client({ host: parentServer.url }).sessions.create({
        message: "Ask the remote child to remember and recall the codeword.",
      });
      expect((await response.result()).status).toBe("waiting");
      const final = await waitFor(session, (events) =>
        filterEventsByType(events, "message.completed").some(
          (event) => event.data.message === "PARENT_RECALLED=LANTERN-COMET-7319",
        ),
      );
      expect(filterEventsByType(final, "session.failed")).toHaveLength(0);
      const starts = filterEventsByType(final, "agent.started");
      expect(starts).toHaveLength(1);
      const remoteClient = new Client({ host: childServer.url, auth: { bearer: TOKEN } });
      const childSnapshot = await remoteClient.sessions
        .attach(starts[0]!.data.sessionId)
        .snapshot();
      expect(filterEventsByType(childSnapshot.events, "turn.started")).toHaveLength(2);
      expect(filterEventsByType(childSnapshot.events, "session.failed")).toHaveLength(0);
    } catch (error) {
      throw new Error(
        `parent stdout:\n${parentServer?.stdout() ?? "not started"}\nparent stderr:\n${parentServer?.stderr() ?? "not started"}\nchild stdout:\n${childServer.stdout()}\nchild stderr:\n${childServer.stderr()}`,
        { cause: error },
      );
    } finally {
      await parentServer?.stop();
      await childServer.stop();
    }
  },
  TIMEOUT,
);

async function waitFor(
  session: ClientSession,
  ready: (events: readonly HandleMessageStreamEvent[]) => boolean,
) {
  const deadline = Date.now() + 30_000;
  let events: readonly HandleMessageStreamEvent[] = [];
  while (Date.now() < deadline) {
    ({ events } = await session.snapshot());
    if (ready(events)) return events;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for events: ${JSON.stringify(events)}`);
}

async function startScriptedEveDev(root: string): Promise<RunningServer> {
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
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (x: string) => {
    stdout += x;
  });
  child.stderr.on("data", (x: string) => {
    stderr += x;
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`startup timeout\n${stdout}\n${stderr}`)),
      30_000,
    );
    const inspect = () => {
      const match = /\[DEV\] server listening at (http:\/\/[^\s]+)/u.exec(stdout);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", inspect);
    child.once("exit", (code) => reject(new Error(`server exited ${code}\n${stdout}\n${stderr}`)));
  });
  return {
    url,
    stdout: () => stdout,
    stderr: () => stderr,
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
    },
  };
}
