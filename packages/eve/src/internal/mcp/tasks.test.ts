import { describe, expect, it } from "vitest";

import { z } from "#compiled/zod/index.js";
import {
  createMcpStreamableHttpServer,
  defineMcpTool,
  MCP_PROTOCOL_VERSION,
} from "#internal/mcp/streamable-http-server.js";
import {
  createMcpTasksFeature,
  MCP_TASKS_EXTENSION,
  type McpTask,
  type McpTaskSource,
} from "#internal/mcp/tasks.js";

const TASK_CAPABILITIES = { extensions: { [MCP_TASKS_EXTENSION]: {} } };

function task(status: string, extra: Record<string, unknown> = {}): McpTask {
  return {
    createdAt: "2026-07-20T00:00:00.000Z",
    lastUpdatedAt: "2026-07-20T00:00:00.000Z",
    status,
    taskId: "task-1",
    ttlMs: null,
    ...extra,
  };
}

function server(states: readonly McpTask[] = [task("working")]) {
  const source: McpTaskSource = {
    start: async (_auth, call) => (call.name === "start" ? task("working") : undefined),
    cancel: async (_auth, taskId) => (taskId === "task-1" ? "cancelled" : "not_found"),
    get: async (_auth, taskId) => (taskId === "task-1" ? states[0] : undefined),
    update: async (_auth, taskId) => (taskId === "task-1" ? "updated" : "not_found"),
    async *watch(_auth, taskId) {
      if (taskId === "task-1") yield* states;
    },
  };
  return createMcpStreamableHttpServer({
    authenticate: async () => null,
    features: [createMcpTasksFeature(source)],
    name: "eve-test",
    tools: [
      defineMcpTool({
        call: async () => ({
          content: [{ text: "started", type: "text" }],
          structuredContent: { invocationId: "task-1" },
        }),
        definition: {
          inputSchema: z.strictObject({}),
          name: "start",
          outputSchema: z.strictObject({ invocationId: z.string() }),
        },
      }),
    ],
    version: "0.0.0",
  });
}

function rpc(
  method: string,
  params: Record<string, unknown>,
  capabilities: unknown = TASK_CAPABILITIES,
): Request {
  const name = typeof params.taskId === "string" ? params.taskId : params.name;
  return new Request("https://agent.example/mcp", {
    body: JSON.stringify({
      id: 7,
      jsonrpc: "2.0",
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": capabilities,
          "io.modelcontextprotocol/clientInfo": { name: "eve-test-client", version: "0.0.0" },
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        },
      },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      ...(typeof name === "string" ? { "mcp-name": name } : {}),
    },
    method: "POST",
  });
}

async function messages(response: Response): Promise<any[]> {
  const body = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return [JSON.parse(body)];
  }
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

describe("MCP tasks extension", () => {
  it("advertises the extension and answers a declaring tools/call with a task", async () => {
    const handle = server();
    const [discovered] = await messages(await handle(rpc("server/discover", {})));
    expect(discovered.result.capabilities).toMatchObject(TASK_CAPABILITIES);

    const [created] = await messages(
      await handle(rpc("tools/call", { arguments: {}, name: "start" })),
    );
    expect(created.result).toMatchObject({
      resultType: "task",
      status: "working",
      taskId: "task-1",
    });
    const [plain] = await messages(
      await handle(rpc("tools/call", { arguments: {}, name: "start" }, {})),
    );
    expect(plain.result).toMatchObject({ content: [{ text: "started" }] });
  });

  it("serves tasks/get, tasks/update, and tasks/cancel", async () => {
    const handle = server();
    const [got] = await messages(await handle(rpc("tasks/get", { taskId: "task-1" })));
    expect(got.result).toMatchObject({ status: "working", taskId: "task-1" });
    const [updated] = await messages(
      await handle(rpc("tasks/update", { inputResponses: {}, taskId: "task-1" })),
    );
    expect(updated.result).toMatchObject({ resultType: "complete" });
    const [cancelled] = await messages(await handle(rpc("tasks/cancel", { taskId: "task-1" })));
    expect(cancelled.result).toMatchObject({ resultType: "complete" });

    const unknown = await handle(rpc("tasks/get", { taskId: "nope" }));
    expect(unknown.status).toBe(200);
    expect((await messages(unknown))[0].error).toMatchObject({ code: -32602 });
  });

  it("refuses clients that did not declare the extension, and mismatched Mcp-Name", async () => {
    const handle = server();
    const refused = await handle(rpc("tasks/get", { taskId: "task-1" }, {}));
    expect(refused.status).toBe(400);
    expect((await messages(refused))[0].error).toMatchObject({
      code: -32021,
      data: { requiredCapabilities: TASK_CAPABILITIES },
    });

    const mismatched = rpc("tasks/get", { taskId: "task-1" });
    mismatched.headers.set("mcp-name", "task-2");
    const response = await handle(mismatched);
    expect(response.status).toBe(400);
    expect((await messages(response))[0].error).toMatchObject({ code: -32020 });
  });

  it("streams each task state over subscriptions/listen, then completes", async () => {
    const handle = server([
      task("working", { statusMessage: "Querying Snowflake" }),
      task("completed", { result: { content: [] } }),
    ]);
    const stream = await messages(
      await handle(rpc("subscriptions/listen", { notifications: { taskIds: ["task-1", "nope"] } })),
    );
    const subscription = { "io.modelcontextprotocol/subscriptionId": 7 };
    expect(stream).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: { _meta: subscription, notifications: { taskIds: ["task-1"] } },
      },
      expect.objectContaining({
        method: "notifications/tasks",
        params: expect.objectContaining({
          _meta: subscription,
          statusMessage: "Querying Snowflake",
        }),
      }),
      expect.objectContaining({
        method: "notifications/tasks",
        params: expect.objectContaining({ status: "completed" }),
      }),
      expect.objectContaining({
        id: 7,
        result: expect.objectContaining({ resultType: "complete" }),
      }),
    ]);
  });
});
