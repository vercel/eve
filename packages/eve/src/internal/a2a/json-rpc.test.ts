import { describe, expect, it, vi } from "vitest";

import { A2A_REQUEST_BODY_MAX_BYTES, handleA2aJsonRpc, type A2aOperations } from "./json-rpc.js";
import { A2aError, EVE_INTERACTIONS_EXTENSION, type StreamResponse } from "./protocol.js";

const task = {
  contextId: "ctx",
  id: "task",
  status: { state: "TASK_STATE_COMPLETED" as const },
};

function execution(overrides: Partial<A2aOperations> = {}): A2aOperations {
  return {
    cancelTask: vi.fn(),
    getTask: vi.fn().mockResolvedValue(task),
    listTasks: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(task),
    streamMessage: vi.fn(),
    subscribe: vi.fn(),
    ...overrides,
  };
}

function request(
  body: unknown,
  headers: Record<string, string> = { "a2a-version": "1.0" },
): Request {
  return new Request("http://127.0.0.1/eve/v1/a2a", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

async function call(body: unknown, headers?: Record<string, string>, exec = execution()) {
  const response = await handleA2aJsonRpc(request(body, headers), null, exec);
  return { body: (await response.json()) as Record<string, any>, response };
}

describe("handleA2aJsonRpc", () => {
  it("dispatches a method and answers with its result", async () => {
    const exec = execution();
    const { body, response } = await call(
      { id: 1, jsonrpc: "2.0", method: "GetTask", params: { id: "task" } },
      undefined,
      exec,
    );
    expect(body).toEqual({ id: 1, jsonrpc: "2.0", result: task });
    expect(response.headers.get("a2a-version")).toBe("1.0");
    expect(exec.getTask).toHaveBeenCalledWith(
      { id: "task" },
      expect.objectContaining({ auth: null }),
    );
  });

  it("wraps SendMessage's task in the response oneof", async () => {
    const { body } = await call({
      id: "a",
      jsonrpc: "2.0",
      method: "SendMessage",
      params: { message: { messageId: "m", parts: [{ text: "hi" }], role: "ROLE_USER" } },
    });
    expect(body.result).toEqual({ task });
  });

  it("refuses versions other than 1.0, reading an absent one as 0.3", async () => {
    const message = { id: 2, jsonrpc: "2.0", method: "GetTask", params: { id: "task" } };
    const versions: Record<string, string>[] = [
      {},
      { "a2a-version": "0.3" },
      { "a2a-version": "1.1" },
    ];
    for (const headers of versions) {
      const { body } = await call(message, headers);
      expect(body).toMatchObject({ error: { code: -32009 }, id: 2 });
    }
    const viaQuery = await handleA2aJsonRpc(
      new Request("http://127.0.0.1/eve/v1/a2a?A2A-Version=1.0", {
        body: JSON.stringify(message),
        method: "POST",
      }),
      null,
      execution(),
    );
    expect(await viaQuery.json()).toMatchObject({ result: task });
  });

  it("maps malformed requests to JSON-RPC errors", async () => {
    expect((await call("{not json")).body).toMatchObject({ error: { code: -32700 }, id: null });
    expect((await call([{ jsonrpc: "2.0", method: "GetTask" }])).body.error.code).toBe(-32600);
    expect((await call({ jsonrpc: "1.0", method: "GetTask" })).body.error.code).toBe(-32600);
    expect((await call({ id: 3, jsonrpc: "2.0", method: "message/send" })).body).toMatchObject({
      error: { code: -32601 },
      id: 3,
    });
    expect(
      (await call({ id: 4, jsonrpc: "2.0", method: "GetTask", params: {} })).body,
    ).toMatchObject({ error: { code: -32602, data: expect.any(Array) }, id: 4 });
  });

  it("refuses unadvertised capabilities with their spec errors", async () => {
    const codes = await Promise.all(
      [
        "GetExtendedAgentCard",
        "CreateTaskPushNotificationConfig",
        "ListTaskPushNotificationConfigs",
      ].map(
        async (method) =>
          (await call({ id: 5, jsonrpc: "2.0", method, params: {} })).body.error.code,
      ),
    );
    expect(codes).toEqual([-32004, -32003, -32003]);
  });

  it("refuses a body over the cap before reading it", async () => {
    const response = await handleA2aJsonRpc(
      new Request("http://127.0.0.1/eve/v1/a2a", {
        body: "{}",
        headers: {
          "a2a-version": "1.0",
          "content-length": String(A2A_REQUEST_BODY_MAX_BYTES + 1),
        },
        method: "POST",
      }),
      null,
      execution(),
    );
    expect(await response.json()).toMatchObject({ error: { code: -32600 } });
  });

  it("renders A2A errors as given and hides internal ones behind an error id", async () => {
    const notFound = execution({ getTask: vi.fn().mockRejectedValue(A2aError.taskNotFound()) });
    const internal = execution({ getTask: vi.fn().mockRejectedValue(new Error("db password=x")) });
    const message = { id: 6, jsonrpc: "2.0", method: "GetTask", params: { id: "task" } };
    expect((await call(message, undefined, notFound)).body.error).toEqual({
      code: -32001,
      message: "Task not found.",
    });
    const hidden = (await call(message, undefined, internal)).body.error;
    expect(hidden).toMatchObject({ code: -32603, data: { errorId: expect.any(String) } });
    expect(JSON.stringify(hidden)).not.toContain("password");
  });

  it("passes requested extensions through and echoes the one it activates", async () => {
    const exec = execution();
    const { response } = await call(
      { id: 7, jsonrpc: "2.0", method: "GetTask", params: { id: "task" } },
      {
        "a2a-extensions": `https://other.example/ext, ${EVE_INTERACTIONS_EXTENSION}`,
        "a2a-version": "1.0",
      },
      exec,
    );
    expect(response.headers.get("a2a-extensions")).toBe(EVE_INTERACTIONS_EXTENSION);
    const context = vi.mocked(exec.getTask).mock.calls[0]![1];
    expect([...context.extensions]).toEqual([
      "https://other.example/ext",
      EVE_INTERACTIONS_EXTENSION,
    ]);
  });

  it("streams each event as a JSON-RPC response, and a failure as a final error event", async () => {
    async function* events(): AsyncGenerator<StreamResponse> {
      yield { task: { ...task, status: { state: "TASK_STATE_WORKING" } } };
      yield { statusUpdate: { contextId: "ctx", status: task.status, taskId: "task" } };
      throw new Error("lost the stream");
    }
    const exec = execution({ streamMessage: vi.fn().mockResolvedValue(events()) });
    const response = await handleA2aJsonRpc(
      request({
        id: 8,
        jsonrpc: "2.0",
        method: "SendStreamingMessage",
        params: { message: { messageId: "m", parts: [{ text: "hi" }] } },
      }),
      null,
      exec,
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const frames = (await response.text())
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice("data: ".length)));
    expect(frames).toEqual([
      {
        id: 8,
        jsonrpc: "2.0",
        result: { task: { ...task, status: { state: "TASK_STATE_WORKING" } } },
      },
      {
        id: 8,
        jsonrpc: "2.0",
        result: { statusUpdate: { contextId: "ctx", status: task.status, taskId: "task" } },
      },
      {
        error: { code: -32603, data: { errorId: expect.any(String) }, message: "Internal error." },
        id: 8,
        jsonrpc: "2.0",
      },
    ]);
  });

  it("answers a stream that can't start with an ordinary JSON-RPC error", async () => {
    const exec = execution({ subscribe: vi.fn().mockRejectedValue(A2aError.taskNotFound()) });
    const { body, response } = await call(
      { id: 9, jsonrpc: "2.0", method: "SubscribeToTask", params: { id: "task" } },
      undefined,
      exec,
    );
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body.error.code).toBe(-32001);
  });
});
