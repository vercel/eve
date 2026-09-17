import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleA2ARequest } from "#internal/a2a/server.js";
import { projectInvocation, inputResponses } from "#internal/a2a/projection.js";
import {
  InvocationListingLimitError,
  type AgentInvocation,
} from "#internal/invocation/agent-invocation.js";
import type { SessionAuthContext } from "#channel/types.js";

const auth: SessionAuthContext = {
  authenticator: "test",
  principalType: "user",
  principalId: "alice",
  attributes: {},
};
const base = { invocationId: "task-1", createdAt: "2026-09-01T00:00:00Z" };
const completed: AgentInvocation = { ...base, status: "completed", result: { answer: 42 } };
const create = vi.fn();
const read = vi.fn();
const update = vi.fn();
const cancel = vi.fn();
const list = vi.fn();
const execution = {
  create,
  read,
  update,
  cancel,
  list,
  history: vi.fn(async () => []),
  ownerKey: () => "owner",
};
const message = { messageId: "message-1", role: "ROLE_USER", parts: [{ text: "Plan the trip." }] };
async function rpc(
  method: string,
  params: unknown = {},
  headers: Record<string, string> = {},
  principal = auth,
) {
  return handleA2ARequest(
    new Request("https://agent.example/eve/v1/a2a", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
    }),
    { auth: principal, execution },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ ...base, status: "working", pollAfterMs: 1 });
  read.mockResolvedValue(completed);
});
describe("A2A JSON-RPC server", () => {
  it("returns a task envelope and keeps task creation asynchronous when requested", async () => {
    expect(
      await (
        await rpc("SendMessage", {
          message,
          configuration: { returnImmediately: true, historyLength: 0 },
        })
      ).json(),
    ).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      result: { task: { id: "task-1", status: { state: "TASK_STATE_SUBMITTED" } } },
    });
    expect(create).toHaveBeenCalledWith({ auth, message: "Plan the trip." });
    expect(read).not.toHaveBeenCalled();
  });
  it("blocks until completion by default", async () => {
    expect(await (await rpc("SendMessage", { message })).json()).toMatchObject({
      result: {
        task: {
          status: { state: "TASK_STATE_COMPLETED" },
          artifacts: [{ parts: [{ data: { answer: 42 } }] }],
        },
      },
    });
  });
  it("hides unknown or inaccessible task ids and passes auth to every read", async () => {
    read.mockResolvedValue(undefined);
    for (const method of ["GetTask", "CancelTask", "SubscribeToTask"]) {
      expect(await (await rpc(method, { id: "hidden" })).json()).toMatchObject({
        error: { code: -32001 },
      });
    }
    expect(read).toHaveBeenCalledWith({ auth, invocationId: "hidden" });
  });
  it("validates the envelope, protocol, tenant, role, raw parts, and history bounds", async () => {
    for (const [params, headers, code] of [
      [{ message }, { "a2a-version": "0.3" }, -32009],
      [{ message, tenant: "other" }, {}, -32602],
      [{ message: { ...message, role: "ROLE_AGENT" } }, {}, -32602],
      [{ message: { ...message, parts: [{ raw: "YQ==" }] } }, {}, -32005],
      [{ message: { ...message, parts: [{ text: "a", data: 1 }] } }, {}, -32602],
      [{ message, configuration: { historyLength: -1 } }, {}, -32602],
    ] as const)
      expect(await (await rpc("SendMessage", params, headers)).json()).toMatchObject({
        error: { code },
      });
    expect(create).not.toHaveBeenCalled();
  });
  it("rejects unsupported features before creating work", async () => {
    expect(
      await (
        await rpc("SendMessage", {
          message,
          configuration: { taskPushNotificationConfig: { url: "https://example.com" } },
        })
      ).json(),
    ).toMatchObject({ error: { code: -32003 } });
    expect(await (await rpc("GetExtendedAgentCard")).json()).toMatchObject({
      error: { code: -32004 },
    });
    expect(await (await rpc("message/send")).json()).toMatchObject({ error: { code: -32601 } });
    expect(create).not.toHaveBeenCalled();
  });
  it("rejects oversized bodies without creating work", async () => {
    expect(
      await (
        await rpc("SendMessage", {
          message: { ...message, parts: [{ text: "x".repeat(1_048_576) }] },
        })
      ).json(),
    ).toMatchObject({ error: { code: -32600 } });
    expect(create).not.toHaveBeenCalled();
  });
  it("orders streaming snapshot, artifact, and final status", async () => {
    const response = await rpc("SendStreamingMessage", {
      message,
      configuration: { historyLength: 0 },
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const results = (await response.text())
      .trim()
      .split("\n\n")
      .map((line) => JSON.parse(line.slice(6)).result);
    expect(results.map((result) => Object.keys(result)[0])).toEqual([
      "task",
      "artifactUpdate",
      "statusUpdate",
    ]);
    expect(results[2].statusUpdate.status.state).toBe("TASK_STATE_COMPLETED");
  });
  it("supports filtered owner-scoped list pagination and excludes artifacts by default", async () => {
    list.mockResolvedValue([completed, { ...completed, invocationId: "task-2" }]);
    const first = (await (await rpc("ListTasks", { pageSize: 1 })).json()) as {
      result: { tasks: { id: string; artifacts?: unknown }[]; nextPageToken: string };
      error?: unknown;
    };
    expect(first.result).toMatchObject({ totalSize: 2, pageSize: 1, tasks: [{ id: "task-1" }] });
    expect(first.result.tasks[0]!.artifacts).toBeUndefined();
    read.mockResolvedValue({ ...completed, invocationId: "task-2" });
    const second = (await (
      await rpc("ListTasks", { pageSize: 1, pageToken: first.result.nextPageToken })
    ).json()) as {
      result: { tasks: { id: string; artifacts?: unknown }[]; nextPageToken: string };
      error?: unknown;
    };
    expect(second.result.tasks[0]!.id).toBe("task-2");
    expect(second.result.nextPageToken).toBe("");
    expect(list).toHaveBeenCalledWith({ auth });
    expect(
      await (
        await rpc("ListTasks", {
          pageToken: first.result.nextPageToken,
          status: "TASK_STATE_FAILED",
        })
      ).json(),
    ).toMatchObject({ error: { code: -32602 } });
  });
  it("provides a direct lookup recovery when general listing exceeds its bound", async () => {
    list.mockRejectedValue(new InvocationListingLimitError());
    expect(await (await rpc("ListTasks")).json()).toMatchObject({
      error: { code: -32004, message: expect.stringContaining("Supply contextId") },
    });
    expect(await (await rpc("ListTasks", { contextId: "task-1" })).json()).toMatchObject({
      result: { totalSize: 1, tasks: [{ id: "task-1" }] },
    });
  });
  it("does not enumerate anonymous bearer-capability task ids", async () => {
    const result = (await (
      await rpc("ListTasks", {}, {}, { ...auth, principalType: "anonymous" })
    ).json()) as {
      result: { tasks: { id: string; artifacts?: unknown }[]; nextPageToken: string };
      error?: unknown;
    };
    expect(result.result.tasks).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });
  it("never exposes an internal failure", async () => {
    read.mockRejectedValue(new Error("secret db hostname"));
    expect(JSON.stringify(await (await rpc("GetTask", { id: "task-1" })).json())).not.toContain(
      "secret",
    );
    expect(
      JSON.stringify(
        projectInvocation({ ...base, status: "failed", error: { code: 1, message: "secret" } }),
      ),
    ).not.toContain("secret");
  });
  it("answers a single pending question with a normal message", async () => {
    const pending: AgentInvocation = {
      ...base,
      status: "input_required",
      inputRequests: {
        request: {
          requestId: "request",
          prompt: "Destination?",
          kind: "question",
          action: { kind: "tool-call", callId: "call", toolName: "ask_question", input: {} },
        },
      },
    };
    read.mockResolvedValue(pending);
    update.mockResolvedValue({ type: "success", invocation: completed });
    const result = (await (
      await rpc("SendMessage", {
        message: { ...message, taskId: "task-1" },
        configuration: { returnImmediately: true, historyLength: 0 },
      })
    ).json()) as {
      result: { tasks: { id: string; artifacts?: unknown }[]; nextPageToken: string };
      error?: unknown;
    };
    expect(result.error).toBeUndefined();
    expect(update).toHaveBeenCalledWith({
      auth,
      invocationId: "task-1",
      responses: [{ requestId: "request", text: "Plan the trip." }],
    });
    expect(
      inputResponses(
        {
          ...message,
          role: "ROLE_USER",
          parts: [{ data: { inputResponses: [{ requestId: "request", text: "Paris" }] } }],
        },
        pending,
      ),
    ).toEqual([{ requestId: "request", text: "Paris" }]);
  });
});
