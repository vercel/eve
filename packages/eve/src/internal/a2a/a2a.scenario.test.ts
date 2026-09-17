import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ClientFactory, JsonRpcTransportFactory, type Client } from "@a2a-js/sdk/client";
import { type ScenarioAppDescriptor, useScenarioApp } from "#internal/testing/scenario-app.js";
import {
  SendMessageRequest,
  GetTaskRequest,
  CancelTaskRequest,
  ListTasksRequest,
  Task,
  StreamResponse,
} from "@a2a-js/sdk";
import { taskSchema } from "#internal/a2a/protocol.js";
const scenarioApp = useScenarioApp();

const channel = `import { a2aChannel } from "eve/channels/a2a";
import { none } from "eve/channels/auth";
export default a2aChannel({ auth: none() });`;
const server: ScenarioAppDescriptor = {
  name: "a2a-server",
  installDependencies: true,
  files: {
    "agent/channels/a2a.ts": channel,
    "agent/instructions.md": "Help Alice and Bob plan trips.",
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({ description: "An A2A planning agent.", modelContextWindowTokens: 32000,
model: mockModel((request) => {
  if (request.userMessages.some(message => message.includes("ask Alice")) && !request.toolResults.some(result => result.name === "ask_question")) {
    return { toolCalls: [{ id: "question", name: "ask_question", input: { prompt: "Which city should Alice visit?" } }] };
  }
  return "A2A-TRIP-COMPLETE";
}) });`,
  },
};
const caller: ScenarioAppDescriptor = {
  name: "a2a-caller",
  installDependencies: true,
  files: {
    "agent/channels/a2a.ts": channel,
    "agent/instructions.md": "Help Alice and Bob plan trips.",
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({ description: "Delegates planning.", modelContextWindowTokens: 32000,
model: mockModel((request) => {
  const result = request.toolResults.find(result => result.name === "delegate");
  if (result) return JSON.stringify(result.output);
  return { toolCalls: [{ id: "delegate", name: "delegate", input: {} }] };
}) });`,
    "agent/subagents/planner.ts": `import { defineA2AAgent } from "eve";
export default defineA2AAgent({ url: () => process.env.A2A_PEER_URL!, description: "Plans a trip." });`,
    "agent/tools/delegate.ts": `import { defineWorkflowTool } from "eve/tools";
export default defineWorkflowTool({ description: "Delegate a trip.", inputSchema: { type: "object", properties: {}, additionalProperties: false },
async execute(_input, ctx) { "use workflow"; return await ctx.agent("planner", { message: "Plan Alice's trip." }); }
});`,
  },
};

function request(text: string, taskId?: string, returnImmediately = false) {
  return SendMessageRequest.fromJSON({
    message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], taskId },
    configuration: { returnImmediately },
  });
}
async function send(client: Client, text: string, taskId?: string, returnImmediately = false) {
  const result = await client.sendMessage(request(text, taskId, returnImmediately));
  if (!("status" in result)) throw new Error("Expected a task");
  return taskSchema.parse(Task.toJSON(result));
}

describe("A2A interoperability", () => {
  it("serves the official client, resumes input, cancels, streams, and delegates through a durable A2A subagent", async () => {
    const app = await scenarioApp(server);
    const receiver = await startEveDev(app.appRoot);
    let sender: RunningEveDev | undefined;
    try {
      const sdk = await new ClientFactory({
        transports: [new JsonRpcTransportFactory()],
      }).createFromUrl(receiver.url);
      const result = await send(sdk, "Plan Alice's trip.");
      expect(result).toMatchObject({
        status: { state: "TASK_STATE_COMPLETED" },
        artifacts: [{ parts: [{ text: "A2A-TRIP-COMPLETE" }] }],
      });
      const pending = await send(sdk, "Please ask Alice which city to visit.");
      expect(pending.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
      const completed = await send(sdk, "Paris", pending.id);
      expect(completed).toMatchObject({
        id: pending.id,
        status: { state: "TASK_STATE_COMPLETED" },
      });
      const waiting = await send(sdk, "Please ask Alice which city to visit.");
      expect(
        Task.toJSON(await sdk.cancelTask(CancelTaskRequest.fromJSON({ id: waiting.id }))),
      ).toMatchObject({ status: { state: "TASK_STATE_CANCELED" } });
      const stream = [];
      for await (const event of sdk.sendMessageStream(request("Plan Bob's trip.")))
        stream.push(StreamResponse.toJSON(event));
      expect(stream[0]).toHaveProperty("task");
      expect(stream.at(-1)).toMatchObject({
        statusUpdate: { status: { state: "TASK_STATE_COMPLETED" } },
      });
      expect(
        await sdk.listTasks(ListTasksRequest.fromJSON({ contextId: pending.id })),
      ).toMatchObject({ totalSize: 1 });
      const callerApp = await scenarioApp(caller);
      sender = await startEveDev(callerApp.appRoot, { A2A_PEER_URL: receiver.url });
      const parent = await new ClientFactory({
        transports: [new JsonRpcTransportFactory()],
      }).createFromUrl(sender.url);
      const delegated = await send(parent, "Arrange Alice's trip.", undefined, true);
      const deadline = Date.now() + 90_000;
      let task = delegated;
      while (
        task.status.state === "TASK_STATE_WORKING" ||
        task.status.state === "TASK_STATE_SUBMITTED"
      ) {
        if (Date.now() > deadline)
          throw new Error(`Delegation timed out. ${sender.stdout()} ${sender.stderr()}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        task = taskSchema.parse(
          Task.toJSON(await parent.getTask(GetTaskRequest.fromJSON({ id: task.id }))),
        );
      }
      expect(task.status.state, sender.stdout() + sender.stderr()).toBe("TASK_STATE_COMPLETED");
      expect(JSON.stringify(task.artifacts), sender.stdout() + sender.stderr()).toContain(
        "A2A-TRIP-COMPLETE",
      );
    } finally {
      await sender?.stop();
      await receiver.stop();
    }
  }, 360_000);
  it("resolves static and dynamic credentials inside durable A2A request steps", async () => {
    const secured = await scenarioApp({
      ...server,
      files: {
        ...server.files,
        "agent/channels/a2a.ts": `import { a2aChannel } from "eve/channels/a2a";
export default a2aChannel({
  auth: (request) => request.headers.get("authorization") === "Bearer scenario-token" && request.headers.get("x-a2a-test") === "request"
    ? { authenticator: "scenario", principalType: "app", principalId: "planner", attributes: {} } : null,
  card: { securitySchemes: { token: { httpAuthSecurityScheme: { scheme: "bearer" } } }, securityRequirements: [{ schemes: { token: { list: [] } } }] }
});`,
      },
    });
    const receiver = await startEveDev(secured.appRoot);
    let sender: RunningEveDev | undefined;
    try {
      const authorized = await scenarioApp({
        ...caller,
        files: {
          ...caller.files,
          "agent/subagents/planner.ts": `import { defineA2AAgent } from "eve";
export default defineA2AAgent({ url: () => process.env.A2A_PEER_URL!, description: "Plans a trip.",
  auth: { getToken: async () => ({ token: "scenario-token" }) }, headers: () => ({ "x-a2a-test": "request" }) });`,
          "agent/subagents/dynamic.ts": `import { defineA2AAgent, defineDynamic } from "eve";
export default defineDynamic({ events: { "session.started": () => defineA2AAgent({
  url: () => process.env.A2A_PEER_URL!, description: "Plans a dynamic trip.",
  auth: { getToken: async () => ({ token: "scenario-token" }) }, headers: () => ({ "x-a2a-test": "request" })
}) } });`,
          "agent/tools/delegate.ts": `import { defineWorkflowTool } from "eve/tools";
export default defineWorkflowTool({ description: "Delegate trips.", inputSchema: { type: "object", properties: {}, additionalProperties: false },
async execute(_input, ctx) { "use workflow";
  const first = await ctx.agent("planner", { message: "Plan Alice's trip." });
  const second = await ctx.agent("dynamic", { message: "Plan Bob's trip." });
  return { first, second };
} });`,
        },
      });
      sender = await startEveDev(authorized.appRoot, { A2A_PEER_URL: receiver.url });
      const client = await new ClientFactory({
        transports: [new JsonRpcTransportFactory()],
      }).createFromUrl(sender.url);
      let task = await send(client, "Arrange Alice and Bob's trips.", undefined, true);
      const deadline = Date.now() + 90_000;
      while (["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"].includes(task.status.state)) {
        if (Date.now() > deadline)
          throw new Error(`Delegation timed out. ${sender.stdout()} ${sender.stderr()}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        task = taskSchema.parse(
          Task.toJSON(await client.getTask(GetTaskRequest.fromJSON({ id: task.id }))),
        );
      }
      expect(task.status.state, sender.stdout() + sender.stderr()).toBe("TASK_STATE_COMPLETED");
      expect(
        JSON.stringify(task.artifacts).match(/A2A-TRIP-COMPLETE/g),
        sender.stdout() + sender.stderr(),
      ).toHaveLength(2);
      const owner = await new ClientFactory({
        transports: [
          new JsonRpcTransportFactory({
            fetchImpl: (url, init) => {
              const headers = new Headers(init?.headers);
              headers.set("authorization", "Bearer scenario-token");
              headers.set("x-a2a-test", "request");
              return fetch(url, { ...init, headers });
            },
          }),
        ],
      }).createFromUrl(receiver.url);
      const listing = await owner.listTasks(ListTasksRequest.fromJSON({ pageSize: 1 }));
      expect(listing.totalSize).toBe(2);
      expect(listing.tasks).toHaveLength(1);
      expect(listing.nextPageToken).toBeTruthy();
      const secondPage = await owner.listTasks(
        ListTasksRequest.fromJSON({ pageToken: listing.nextPageToken, pageSize: 1 }),
      );
      expect(secondPage.tasks[0]?.id).not.toBe(listing.tasks[0]?.id);
    } finally {
      await sender?.stop();
      await receiver.stop();
    }
  }, 360_000);
});

interface RunningEveDev {
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
  stop(): Promise<void>;
}

async function startEveDev(
  appRoot: string,
  env: Record<string, string> = {},
): Promise<RunningEveDev> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(
    process.execPath,
    [eveBinPath, "dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      env: { ...process.env, EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production", ...env },
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
    }, 60_000);
    function inspect() {
      const url = /\[DEV\] server listening at (http:\/\/[^\s]+)/u.exec(output().stdout)?.[1];
      if (url !== undefined) {
        cleanup();
        resolve(url);
      }
    }
    function exited(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      reject(
        new Error(
          `eve dev exited before startup (code ${String(code)}, ${String(signal)}). ${output().stdout} ${output().stderr}`,
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
