import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { type ScenarioAppDescriptor, useScenarioApp } from "#internal/testing/scenario-app.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const OPERATION_TIMEOUT_MS = 30_000;
const MCP_PROTOCOL_VERSION = "2026-07-28";
const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

const MCP_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const model = mockModel((request) => {
  const prompt = JSON.stringify(request.messages);
  if (prompt.includes("MCP-FAILURE-PROBE")) {
    throw new Error("MCP-FAILURE-PROBE: provider rejected the request.");
  }
  const queried = request.toolResults.some((result) => result.name === "query_warehouse");
  if (prompt.includes("MCP-TASKS-PROBE") && !queried) {
    return { toolCalls: [{ id: "query-1", input: {}, name: "query_warehouse" }] };
  }
  const answered = request.toolResults.some((result) => result.name === "ask_question");
  if (!answered) {
    return {
      toolCalls: [{
        id: "question-1",
        input: {
          options: [
            { description: "Continue the delegated work.", label: "Yes" },
            { description: "Stop before the delegated work.", label: "No" },
          ],
          question: "Proceed with the delegated work?",
        },
        name: "ask_question",
      }],
    };
  }
  return "MCP-LIFECYCLE-COMPLETE";
});

export default defineAgent({
  description: "Exercises the durable MCP invocation lifecycle.",
  model,
  modelContextWindowTokens: 32_000,
});
`,
    "agent/channels/mcp.ts": `import { mcpChannel } from "eve/channels/mcp";

export default mcpChannel({
  auth: (request) => {
    const principalId = request.headers.get("x-test-principal");
    return principalId === null
      ? null
      : { attributes: {}, authenticator: "scenario", principalId, principalType: "user" };
  },
});
`,
    "agent/instructions.md": "Follow the deterministic mock-model lifecycle.\n",
    "agent/tools/ask_question.ts":
      'import { askQuestion } from "eve/tools/ask_question";\n\nexport default askQuestion;\n',
    "agent/tools/query_warehouse.ts": `import { defineTool } from "eve/tools";

export default defineTool({
  description: "Queries the warehouse slowly.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    return "42 rows";
  },
});
`,
  },
  dependencies: { "just-bash": "3.4.2" },
  installDependencies: true,
  name: "mcp-agent-channel",
};

describe("MCP agent channel", () => {
  it(
    "runs a durable input lifecycle through modern and legacy Nitro requests",
    async () => {
      const app = await scenarioApp(MCP_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const started = await callTool(server.url, "alice", "modern", "agent_start", {
          message: "Run the lifecycle.",
        });
        const invocationId = requiredString(started.invocationId, "invocationId");
        const pending = await pollInvocation(server.url, "alice", "modern", invocationId, [
          "input_required",
        ]);
        const interactionId = requiredString(
          Object.keys(requiredRecord(pending.interactions, "interactions"))[0],
          "interactionId",
        );

        const hidden = await callToolResult(server.url, "bob", "modern", "agent_get", {
          invocationId,
        });
        expect(hidden.isError).toBe(true);

        const responses = [{ interactionId, optionId: "Yes" }];
        await expect(
          callTool(server.url, "alice", "modern", "agent_update", {
            invocationId,
            responses,
          }),
        ).resolves.toMatchObject({ invocationId });

        const completed = await pollInvocation(server.url, "alice", "modern", invocationId, [
          "completed",
        ]);
        expect(completed).toMatchObject({ result: "MCP-LIFECYCLE-COMPLETE" });
        await initializeLegacy(server.url, "alice");
        const legacyStarted = await callTool(server.url, "alice", "legacy", "agent_start", {
          message: "Cancel this lifecycle.",
        });
        const legacyInvocationId = requiredString(legacyStarted.invocationId, "invocationId");
        await pollInvocation(server.url, "alice", "legacy", legacyInvocationId, ["input_required"]);
        await expect(
          callTool(server.url, "alice", "legacy", "agent_cancel", {
            invocationId: legacyInvocationId,
          }),
        ).resolves.toMatchObject({ invocationId: legacyInvocationId });
        await expect(
          pollInvocation(server.url, "alice", "legacy", legacyInvocationId, ["cancelled"]),
        ).resolves.toMatchObject({ status: "cancelled" });

        const failing = await callTool(server.url, "alice", "modern", "agent_start", {
          message: "Trigger MCP-FAILURE-PROBE.",
        });
        const failingInvocationId = requiredString(failing.invocationId, "invocationId");
        const failed = await pollInvocation(server.url, "alice", "modern", failingInvocationId, [
          "failed",
        ]);
        const failure = requiredRecord(failed.error, "error");
        expect(typeof failure.message).toBe("string");
        expect((failure.message as string).length).toBeGreaterThan(0);
        expect(requiredRecord(failure.data, "error.data")).toMatchObject({
          runId: failingInvocationId,
        });
        const serialized = JSON.stringify(failed);
        expect(serialized).not.toMatch(/\n\s+at /);
        expect(serialized).not.toContain("stack");
        expect(serialized.length).toBeLessThan(4_096);

        const unknown = await callToolResult(server.url, "alice", "modern", "agent_get", {
          invocationId: "does-not-exist",
        });
        expect(unknown.isError).toBe(true);
        const notPending = await callToolResult(server.url, "alice", "modern", "agent_update", {
          invocationId,
          responses: [{ interactionId: "stale", optionId: "yes" }],
        });
        expect(notPending.isError).toBe(true);
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
    "serves an invocation as an MCP task with live status",
    async () => {
      const app = await scenarioApp(MCP_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        // Without the extension, tasks/* is refused and agent_start stays tool-shaped.
        const refused = await mcpRequest(server.url, "alice", "modern", "tasks/get", {
          taskId: "anything",
        });
        expect(refused.status).toBe(400);
        expect(await readJsonRpcResponse(refused, { allowError: true })).toMatchObject({
          error: { code: -32021 },
        });

        const created = await callToolResult(server.url, "alice", "tasks", "agent_start", {
          message: "Run MCP-TASKS-PROBE.",
        });
        expect(created).toMatchObject({ resultType: "task", status: "working" });
        const taskId = requiredString(created.taskId, "taskId");
        expect(await taskRequest(server.url, "alice", "tasks/get", { taskId })).toMatchObject({
          taskId,
        });

        const live = await listenTask(
          server.url,
          "alice",
          taskId,
          (task) => task.status === "input_required",
        );
        expect(live[0]).toMatchObject({
          method: "notifications/subscriptions/acknowledged",
          params: { notifications: { taskIds: [taskId] } },
        });
        const tasks = live.slice(1).map((message) => requiredRecord(message.params, "params"));
        expect(tasks.map((task) => task.statusMessage)).toContain("Query warehouse");
        const pending = tasks.at(-1)!;
        const [requestKey, elicitation] = Object.entries(
          requiredRecord(pending.inputRequests, "inputRequests"),
        )[0]!;
        expect(elicitation).toMatchObject({
          method: "elicitation/create",
          params: {
            message: "Proceed with the delegated work?",
            mode: "form",
            requestedSchema: { properties: { answer: { type: "string" } } },
          },
        });
        await expect(taskRequest(server.url, "bob", "tasks/get", { taskId })).rejects.toThrow(
          /-32602/,
        );

        await taskRequest(server.url, "alice", "tasks/update", {
          inputResponses: { [requestKey]: { action: "accept", content: { answer: "Yes" } } },
          taskId,
        });
        const finished = await listenTask(
          server.url,
          "alice",
          taskId,
          (task) => task.status === "completed",
        );
        expect(finished.at(-1)).toMatchObject({
          params: {
            result: { structuredContent: { result: "MCP-LIFECYCLE-COMPLETE" } },
            status: "completed",
          },
        });
        // The tools still read the same invocation, in their own shape.
        const invocation = await callTool(server.url, "alice", "modern", "agent_get", {
          invocationId: taskId,
        });
        expect(invocation).toMatchObject({ result: "MCP-LIFECYCLE-COMPLETE" });
        expect(invocation).not.toHaveProperty("updatedAt");
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
});

/** `tasks` is the modern era with the Tasks extension declared. */
type McpEra = "legacy" | "modern" | "tasks";

async function callTool(
  serverUrl: string,
  principal: string,
  era: McpEra,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const result = await callToolResult(serverUrl, principal, era, name, args);
  if (result.isError === true) {
    throw new Error(`MCP tool ${name} failed: ${JSON.stringify(result.content)}`);
  }
  return requiredRecord(result.structuredContent, `${name}.structuredContent`);
}

async function callToolResult(
  serverUrl: string,
  principal: string,
  era: McpEra,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const response = await mcpRequest(serverUrl, principal, era, "tools/call", {
    arguments: args,
    name,
  });
  const envelope = requiredRecord(await readJsonRpcResponse(response), "JSON-RPC envelope");
  return requiredRecord(requiredRecord(envelope.result, "result"), "tool result");
}

async function initializeLegacy(serverUrl: string, principal: string): Promise<void> {
  const response = await mcpRequest(serverUrl, principal, "legacy", "initialize", {
    capabilities: {},
    clientInfo: { name: "eve-scenario", version: "0.0.0" },
    protocolVersion: "2025-11-25",
  });
  expect(response.ok).toBe(true);
}

async function pollInvocation(
  serverUrl: string,
  principal: string,
  era: McpEra,
  invocationId: string,
  statuses: readonly string[],
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const invocation = await callTool(serverUrl, principal, era, "agent_get", { invocationId });
    if (typeof invocation.status === "string" && statuses.includes(invocation.status)) {
      return invocation;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${statuses.join(" or ")} on ${invocationId}.`);
}

async function taskRequest(
  serverUrl: string,
  principal: string,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const response = await mcpRequest(serverUrl, principal, "tasks", method, params);
  const envelope = requiredRecord(await readJsonRpcResponse(response), "JSON-RPC envelope");
  if (envelope.error !== undefined) {
    throw new Error(`MCP ${method} failed: ${JSON.stringify(envelope.error)}`);
  }
  return requiredRecord(envelope.result, "result");
}

/** Listens to one task until `until` matches a notification, returning every message so far. */
async function listenTask(
  serverUrl: string,
  principal: string,
  taskId: string,
  until: (task: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), OPERATION_TIMEOUT_MS);
  const response = await mcpRequest(
    serverUrl,
    principal,
    "tasks",
    "subscriptions/listen",
    { notifications: { taskIds: [taskId] } },
    abort.signal,
  );
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const messages: Record<string, unknown>[] = [];
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for await (const chunk of response.body!) {
      buffered += decoder.decode(chunk, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop()!;
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data === undefined) continue;
        const message = requiredRecord(JSON.parse(data.slice("data: ".length)), "message");
        messages.push(message);
        if (
          message.method === "notifications/tasks" &&
          until(requiredRecord(message.params, "params"))
        ) {
          return messages;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
  throw new Error(`Task listen ended before the expected state: ${JSON.stringify(messages)}`);
}

async function mcpRequest(
  serverUrl: string,
  principal: string,
  era: McpEra,
  method: string,
  params: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<Response> {
  const modernMeta =
    era !== "legacy"
      ? {
          _meta: {
            "io.modelcontextprotocol/clientCapabilities":
              era === "tasks" ? { extensions: { [MCP_TASKS_EXTENSION]: {} } } : {},
            "io.modelcontextprotocol/clientInfo": { name: "eve-scenario", version: "0.0.0" },
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          },
        }
      : {};
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "x-test-principal": principal,
  };
  if (era !== "legacy") {
    headers["mcp-method"] = method;
    headers["mcp-protocol-version"] = MCP_PROTOCOL_VERSION;
    if (typeof params.name === "string") headers["mcp-name"] = params.name;
    if (typeof params.taskId === "string") headers["mcp-name"] = params.taskId;
  }
  return await fetch(new URL("/eve/v1/mcp", serverUrl), {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method,
      params: { ...params, ...modernMeta },
    }),
    headers,
    method: "POST",
    signal,
  });
}

async function readJsonRpcResponse(
  response: Response,
  options: { readonly allowError?: boolean } = {},
): Promise<unknown> {
  const body = await response.text();
  if (!response.ok && options.allowError !== true) {
    throw new Error(`MCP HTTP ${response.status}: ${body}`);
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body);
  }
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  if (data === undefined) throw new Error("MCP response did not contain an SSE data event.");
  return JSON.parse(data.slice("data: ".length));
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} was not an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} was not a non-empty string.`);
  }
  return value;
}

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
    }, OPERATION_TIMEOUT_MS);
    function inspect() {
      const url = /\[DEV\] server listening at (http:\/\/[^\s]+)/u.exec(output().stdout)?.[1];
      if (url !== undefined) {
        cleanup();
        resolve(url);
      }
    }
    function exited(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      reject(new Error(`eve dev exited before startup (code ${String(code)}, ${String(signal)}).`));
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
