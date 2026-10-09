import type { SessionStreamEvent } from "#protocol/session-event.js";
import { RequestError, type AgentContext } from "#compiled/@agentclientprotocol/sdk/index.js";
import { describe, expect, it, vi } from "vitest";

import { EveAcpAdapter } from "#acp/adapter.js";
import { ClientError } from "#client/client-error.js";
import type { SendTurnInput, SendTurnPayload } from "#client/types.js";

type TestStreamEvent<T = SessionStreamEvent> = T extends unknown ? Omit<T, "meta"> : never;

class FakeClientSession {
  readonly cancel = vi.fn(async () => ({ sessionId: "session_test", status: "accepted" }));
  readonly reset = vi.fn(async () => ({ status: "reset" }));
  readonly sends: SendTurnPayload[] = [];
  readonly #turns: Array<readonly TestStreamEvent[]>;

  constructor(turns: Array<readonly TestStreamEvent[]>) {
    this.#turns = turns;
  }

  async send(message: SendTurnInput["message"]): Promise<AsyncIterable<SessionStreamEvent>> {
    return await this.#next({ message });
  }

  async respond(
    inputResponses: NonNullable<SendTurnPayload["inputResponses"]>,
  ): Promise<AsyncIterable<SessionStreamEvent>> {
    return await this.#next({ inputResponses });
  }

  async #next(input: SendTurnPayload): Promise<AsyncIterable<SessionStreamEvent>> {
    this.sends.push(input);
    const events = this.#turns.shift() ?? [];
    return (async function* () {
      for (const [index, event] of events.entries()) {
        yield {
          ...event,
          meta: { at: "2026-07-29T00:00:00.000Z", id: `event-${index}` },
        } as SessionStreamEvent;
      }
    })();
  }
}

function fakeClient(session: FakeClientSession) {
  return {
    sessions: {
      async create(input: SendTurnInput) {
        return { response: await session.send(input.message), session };
      },
    },
  };
}

function adapterWith(turns: Array<readonly TestStreamEvent[]> = []) {
  const session = new FakeClientSession(turns);
  const adapter = new EveAcpAdapter({
    client: fakeClient(session),
    eveVersion: "1.2.3",
    serverUrl: "http://127.0.0.1:2000",
    workspaceRoot: process.cwd(),
  });
  return { adapter, session };
}

function acpClient(input?: { request?: AgentContext["request"] }) {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const notify = vi.fn(async (method: string, params: unknown) => {
    notifications.push({ method, params });
  });
  const request = input?.request ?? vi.fn(async () => ({}));
  return {
    client: Object.assign(Object.create(null), { notify, request }) as AgentContext,
    notifications,
    notify,
    request,
  };
}

async function createSession(adapter: EveAcpAdapter): Promise<string> {
  const result = await adapter.newSession({ cwd: process.cwd(), mcpServers: [] });
  return result.sessionId;
}

const textPrompt = (sessionId: string, text = "hello") => ({
  prompt: [{ type: "text" as const, text }],
  sessionId,
});

describe("EveAcpAdapter", () => {
  it("negotiates stable v1 without advertising workspace capabilities", () => {
    const { adapter } = adapterWith();
    expect(
      adapter.initialize({
        protocolVersion: 2,
        clientCapabilities: { fs: { readTextFile: true }, terminal: true },
      }),
    ).toEqual({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {},
        sessionCapabilities: { close: {} },
      },
      agentInfo: { name: "eve", title: "eve", version: "1.2.3" },
      authMethods: [],
    });
  });

  it("rejects a different local cwd and client-provided MCP before creating a session", async () => {
    const { adapter } = adapterWith();
    await expect(adapter.newSession({ cwd: process.cwd(), mcpServers: [] })).resolves.toEqual({
      sessionId: expect.any(String),
    });
    await expect(
      adapter.newSession({ cwd: process.cwd(), mcpServers: [{} as never] }),
    ).rejects.toThrow("Client-provided MCP servers");
    await expect(adapter.newSession({ cwd: "/", mcpServers: [] })).rejects.toBeInstanceOf(
      RequestError,
    );
  });

  it("does not treat a remote ACP client's cwd as a deployment workspace", async () => {
    const session = new FakeClientSession([]);
    const adapter = new EveAcpAdapter({
      client: fakeClient(session),
      eveVersion: "1.2.3",
      serverUrl: "https://agent.example.com",
    });

    await expect(
      adapter.newSession({ cwd: "/a/client/path-that-does-not-exist", mcpServers: [] }),
    ).resolves.toEqual({ sessionId: expect.any(String) });
  });

  it("streams message, reasoning, and tool lifecycle updates in event order", async () => {
    const events: TestStreamEvent[] = [
      {
        type: "message.appended",
        data: { messageDelta: "Hi", sequence: 1, stepIndex: 0, turnId: "t1" },
      },
      {
        type: "reasoning.appended",
        data: {
          reasoningDelta: "Think",
          sequence: 2,
          stepIndex: 0,
          turnId: "t1",
        },
      },
      {
        type: "actions.requested",
        data: {
          actions: [
            { callId: "call-1", input: { city: "SF" }, kind: "tool-call", toolName: "weather" },
            {
              callId: "workflow-1",
              input: { report: "weekly" },
              kind: "workflow-tool-call",
              toolName: "publish",
              workflowId: "publish-workflow",
            },
          ],
          presentation: { "call-1": { label: "Check the weather in SF" } },
          sequence: 3,
          stepIndex: 0,
          turnId: "t1",
        },
      },
      {
        type: "action.result",
        data: {
          presentation: { "call-1": { label: "Sunny in SF" } },
          result: {
            callId: "call-1",
            kind: "tool-result",
            output: { condition: "sunny" },
            toolName: "weather",
          },
          sequence: 4,
          status: "completed",
          stepIndex: 0,
          turnId: "t1",
        },
      },
      {
        type: "session.waiting",
        data: { continuationToken: "session-id", wait: "next-user-message" },
      },
    ];
    const { adapter, session } = adapterWith([events]);
    const sessionId = await createSession(adapter);
    const { client, notifications } = acpClient();

    await expect(
      adapter.prompt(textPrompt(sessionId), client, new AbortController().signal),
    ).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(session.sends).toEqual([{ message: [{ type: "text", text: "hello" }] }]);
    expect(notifications.map(({ params }) => (params as any).update.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "agent_thought_chunk",
      "tool_call",
      "tool_call",
      "tool_call_update",
    ]);
    expect(notifications.slice(0, 2).map(({ params }) => (params as any).update.messageId)).toEqual(
      ["t1:message:0", "t1:thought:0"],
    );
    // A call reads as its label, or a readable form of its name, and a result can retitle it.
    expect(notifications.slice(2).map(({ params }) => (params as any).update.title)).toEqual([
      "Check the weather in SF",
      "Publish",
      "Sunny in SF",
    ]);
    expect(JSON.stringify(notifications)).not.toContain("secret");
  });

  it("round-trips a confirmation response through the same logical prompt", async () => {
    const action = {
      callId: "call-1",
      input: { path: "x" },
      kind: "tool-call" as const,
      toolName: "write",
    };
    const { adapter, session } = adapterWith([
      [
        {
          type: "actions.requested",
          data: { actions: [action], sequence: 1, stepIndex: 0, turnId: "t1" },
        },
        {
          type: "input.requested",
          data: {
            requests: [
              {
                action,
                display: "confirmation",
                kind: "tool-approval",
                options: [
                  { id: "approve", label: "Approve" },
                  { id: "deny", label: "Deny" },
                ],
                prompt: "Allow write?",
                requestId: "request-1",
              },
            ],
            sequence: 2,
            stepIndex: 0,
            turnId: "t1",
          },
        },
        {
          type: "session.waiting",
          data: { continuationToken: "session-id", wait: "next-user-message" },
        },
      ],
      [
        {
          type: "session.waiting",
          data: { continuationToken: "session-id", wait: "next-user-message" },
        },
      ],
    ]);
    const request = vi.fn(async (_method: string, params: any) => ({
      outcome: { outcome: "selected", optionId: params.options[0].optionId },
    })) as AgentContext["request"];
    const { client } = acpClient({ request });
    const sessionId = await createSession(adapter);

    await expect(
      adapter.prompt(textPrompt(sessionId), client, new AbortController().signal),
    ).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(request).toHaveBeenCalledOnce();
    expect(session.sends).toHaveLength(2);
    expect(session.sends[1]).toEqual({
      inputResponses: [{ optionId: "approve", requestId: "request-1" }],
    });
  });

  it("round-trips fixed-choice and freeform questions through form elicitation", async () => {
    const action = {
      callId: "call-1",
      input: {},
      kind: "tool-call" as const,
      toolName: "ask_question",
    };
    const { adapter, session } = adapterWith([
      [
        {
          type: "input.requested",
          data: {
            requests: [
              {
                action,
                allowFreeform: false,
                display: "select",
                kind: "question",
                options: [
                  { id: "sunny", label: "Sunny" },
                  { id: "rainy", label: "Rainy" },
                ],
                prompt: "Weather?",
                requestId: "select-1",
              },
              {
                action,
                allowFreeform: true,
                display: "text",
                kind: "question",
                prompt: "Why?",
                requestId: "text-1",
              },
            ],
            sequence: 1,
            stepIndex: 0,
            turnId: "turn-1",
          },
        },
        {
          type: "session.waiting",
          data: { continuationToken: "session-id", wait: "next-user-message" },
        },
      ],
      [
        {
          type: "session.waiting",
          data: { continuationToken: "session-id", wait: "next-user-message" },
        },
      ],
    ]);
    adapter.initialize({
      clientCapabilities: { elicitation: { form: {} } },
      protocolVersion: 1,
    });
    const request = vi.fn(async (_method: string, params: any) => ({
      action: "accept",
      content: {
        answer: params.requestedSchema.properties.answer.oneOf ? "sunny" : "Because",
      },
    })) as AgentContext["request"];
    const sessionId = await createSession(adapter);

    await adapter.prompt(
      textPrompt(sessionId),
      acpClient({ request }).client,
      new AbortController().signal,
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(session.sends[1]).toEqual({
      inputResponses: [
        { optionId: "sunny", requestId: "select-1" },
        { requestId: "text-1", text: "Because" },
      ],
    });
  });

  it("cancels an outstanding permission request without parking the ACP prompt", async () => {
    const action = {
      callId: "call-1",
      input: {},
      kind: "tool-call" as const,
      toolName: "write",
    };
    const { adapter, session } = adapterWith([
      [
        {
          type: "input.requested",
          data: {
            requests: [
              {
                action,
                display: "confirmation",
                kind: "tool-approval",
                options: [
                  { id: "approve", label: "Approve" },
                  { id: "deny", label: "Deny" },
                ],
                prompt: "Allow write?",
                requestId: "request-1",
              },
            ],
            sequence: 1,
            stepIndex: 0,
            turnId: "turn-1",
          },
        },
        {
          type: "session.waiting",
          data: { continuationToken: "session-id", wait: "next-user-message" },
        },
      ],
    ]);
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => (requestStarted = resolve));
    const request = vi.fn(
      async (_method: string, _params: unknown, options?: { cancellationSignal?: AbortSignal }) => {
        requestStarted();
        await new Promise<never>((_resolve, reject) => {
          options?.cancellationSignal?.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        });
      },
    ) as AgentContext["request"];
    const sessionId = await createSession(adapter);
    const prompt = adapter.prompt(
      textPrompt(sessionId),
      acpClient({ request }).client,
      new AbortController().signal,
    );
    await started;

    await adapter.cancel(sessionId);
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(session.cancel).toHaveBeenCalledWith({ turnId: "turn-1" });
    expect(session.sends).toHaveLength(1);
  });

  it("does not dispatch a prompt whose JSON-RPC request is already cancelled", async () => {
    const { adapter, session } = adapterWith();
    const sessionId = await createSession(adapter);
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.prompt(textPrompt(sessionId), acpClient().client, controller.signal),
    ).rejects.toMatchObject({ code: -32_800 });
    expect(session.sends).toHaveLength(0);
  });

  it("retries cancellation after the first eve session POST is accepted", async () => {
    let releaseSend!: () => void;
    let sendStarted!: () => void;
    const released = new Promise<void>((resolve) => (releaseSend = resolve));
    const started = new Promise<void>((resolve) => (sendStarted = resolve));
    const session = new FakeClientSession([]);
    session.send = vi.fn(async () => {
      sendStarted();
      await released;
      return (async function* () {
        yield {
          type: "turn.cancelled",
          data: { sequence: 1, turnId: "turn-1" },
        } as SessionStreamEvent;
        yield {
          type: "session.waiting",
          data: { continuationToken: "session-id", wait: "next-user-message" },
        } as SessionStreamEvent;
      })();
    });
    const adapter = new EveAcpAdapter({
      client: fakeClient(session),
      eveVersion: "1.2.3",
      serverUrl: "http://127.0.0.1:2000",
      workspaceRoot: process.cwd(),
    });
    const sessionId = await createSession(adapter);
    const prompt = adapter.prompt(
      textPrompt(sessionId),
      acpClient().client,
      new AbortController().signal,
    );
    await started;

    await adapter.cancel(sessionId);
    expect(session.cancel).not.toHaveBeenCalled();
    releaseSend();

    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(session.cancel).toHaveBeenCalledOnce();
  });

  it("requests cooperative cancellation and waits for the cancelled boundary", async () => {
    let release!: () => void;
    let observeTurn!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const turnObserved = new Promise<void>((resolve) => (observeTurn = resolve));
    const session = new FakeClientSession([]);
    session.send = vi.fn(async () => {
      return (async function* () {
        observeTurn();
        yield {
          type: "turn.started",
          data: { sequence: 0, turnId: "turn-1" },
        } as SessionStreamEvent;
        await pending;
        yield {
          type: "turn.cancelled",
          data: { sequence: 1, turnId: "turn-1" },
        } as SessionStreamEvent;
        yield {
          type: "session.waiting",
          data: { continuationToken: "session-id", wait: "next-user-message" },
        } as SessionStreamEvent;
      })();
    });
    const adapter = new EveAcpAdapter({
      client: fakeClient(session),
      eveVersion: "1.2.3",
      serverUrl: "http://127.0.0.1:2000",
      workspaceRoot: process.cwd(),
    });
    const sessionId = await createSession(adapter);
    const prompt = adapter.prompt(
      textPrompt(sessionId),
      acpClient().client,
      new AbortController().signal,
    );
    await turnObserved;
    await new Promise((resolve) => setTimeout(resolve, 0));

    await adapter.cancel(sessionId);
    expect(session.cancel).toHaveBeenCalledWith({ turnId: "turn-1" });
    release();
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("returns structured eve errors for HTTP failures", async () => {
    const session = new FakeClientSession([]);
    session.send = vi.fn(async () => {
      throw new ClientError(401, JSON.stringify({ error: "Unauthorized" }));
    });
    const adapter = new EveAcpAdapter({
      client: fakeClient(session),
      eveVersion: "1.2.3",
      serverUrl: "https://agent.example.com",
    });
    const sessionId = await createSession(adapter);

    const error = await adapter
      .prompt(textPrompt(sessionId), acpClient().client, new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: -32_002, data: { httpStatus: 401 } });
  });

  it("reports a denied approval as failed, with the denial's reason", async () => {
    const at = { sequence: 1, stepIndex: 0, turnId: "turn-1" };
    const action = { callId: "call-1", input: {}, kind: "tool-call" as const, toolName: "write" };
    const waiting = {
      type: "session.waiting" as const,
      data: { continuationToken: "session-id", wait: "next-user-message" as const },
    };
    const { adapter } = adapterWith([
      [
        { type: "actions.requested", data: { ...at, actions: [action] } },
        {
          type: "input.requested",
          data: {
            ...at,
            requests: [
              {
                action,
                display: "confirmation",
                kind: "tool-approval",
                options: [
                  { id: "approve", label: "Approve" },
                  { id: "deny", label: "Deny" },
                ],
                prompt: "Allow write?",
                requestId: "req-1",
              },
            ],
          },
        },
        waiting,
      ],
      // The denial resolves the request before the result that carries its reason arrives.
      [
        {
          type: "input.resolved",
          data: {
            ...at,
            resolutions: [{ kind: "tool-approval", outcome: "denied", requestId: "req-1" }],
          },
        },
        {
          type: "action.result",
          data: {
            ...at,
            error: { code: "TOOL_EXECUTION_DENIED", message: "Bob declined the write." },
            result: { callId: "call-1", kind: "tool-result", output: "Denied", toolName: "write" },
            status: "rejected",
          },
        },
        waiting,
      ],
    ]);
    const request = vi.fn(async (_method: string, params: any) => ({
      outcome: { outcome: "selected", optionId: params.options[1].optionId },
    })) as AgentContext["request"];
    const { client, notifications } = acpClient({ request });
    const sessionId = await createSession(adapter);

    await adapter.prompt(textPrompt(sessionId), client, new AbortController().signal);

    const updates = notifications
      .map((notification) => (notification.params as any).update)
      .filter((update) => update.sessionUpdate === "tool_call_update");
    expect(updates.at(-1)).toMatchObject({ rawOutput: "Denied", status: "failed" });
  });

  it("fails unsupported authorization requests instead of ending successfully", async () => {
    const { adapter } = adapterWith([
      [
        {
          type: "authorization.required",
          data: {
            description: "Sign in",
            name: "linear",
            sequence: 1,
            stepIndex: 0,
            turnId: "turn-1",
          },
        },
        {
          type: "session.waiting",
          data: { continuationToken: "session-id", wait: "next-user-message" },
        },
      ],
    ]);
    const sessionId = await createSession(adapter);

    await expect(
      adapter.prompt(textPrompt(sessionId), acpClient().client, new AbortController().signal),
    ).rejects.toThrow("cannot be completed");
  });

  it("rejects empty and unsupported prompt content instead of dropping it", async () => {
    const { adapter } = adapterWith();
    const sessionId = await createSession(adapter);
    const signal = new AbortController().signal;
    await expect(
      adapter.prompt(
        { prompt: [{ type: "text", text: "" }], sessionId },
        acpClient().client,
        signal,
      ),
    ).rejects.toThrow("non-empty text block");
    await expect(
      adapter.prompt(
        { prompt: [{ type: "image", data: "a", mimeType: "image/png" }], sessionId },
        acpClient().client,
        signal,
      ),
    ).rejects.toThrow("not supported");
  });

  it("resets owned eve sessions when an ACP session or connection closes", async () => {
    const waitingTurn = [
      {
        type: "session.waiting",
        data: { continuationToken: "session-id", wait: "next-user-message" },
      },
    ] as const;
    const { adapter, session } = adapterWith([waitingTurn, waitingTurn]);
    const first = await createSession(adapter);
    await adapter.prompt(textPrompt(first), acpClient().client, new AbortController().signal);

    await adapter.closeSession(first);
    expect(session.reset).toHaveBeenCalledOnce();
    await expect(
      adapter.prompt(textPrompt(first), acpClient().client, new AbortController().signal),
    ).rejects.toThrow("Unknown or closed");

    const second = await createSession(adapter);
    await adapter.prompt(textPrompt(second), acpClient().client, new AbortController().signal);
    await adapter.close();
    expect(session.reset).toHaveBeenCalledTimes(2);
  });

  it("keeps whole-connection cleanup best-effort when reset fails", async () => {
    const { adapter, session } = adapterWith([
      [
        {
          type: "session.waiting",
          data: { continuationToken: "session-id", wait: "next-user-message" },
        },
      ],
    ]);
    const sessionId = await createSession(adapter);
    await adapter.prompt(textPrompt(sessionId), acpClient().client, new AbortController().signal);
    session.reset.mockRejectedValueOnce(new Error("server already stopped"));

    await expect(adapter.close()).resolves.toBeUndefined();
    expect(session.reset).toHaveBeenCalledOnce();
  });

  it.each(["completed", "cancelled"] as const)(
    "delivers task settlement without output: %s",
    async (status) => {
      const at = { sequence: 0, stepIndex: 0, turnId: "turn_0" };
      const { adapter } = adapterWith([
        [
          { type: "turn.started", data: { sequence: 0, turnId: "turn_0" } },
          {
            type: "actions.requested",
            data: {
              ...at,
              actions: [{ callId: "c", input: {}, kind: "tool-call", toolName: "research" }],
            },
          },
          {
            type: "task.started",
            data: { callId: "c", kind: "tool", name: "research", taskId: "t", turnId: "turn_0" },
          },
          {
            type: "action.result",
            data: {
              ...at,
              result: { callId: "c", kind: "tool-result", toolName: "research", output: "Started" },
              status: "completed",
            },
          },
          { type: "task.settled", data: { callId: "c", taskId: "t", turnId: "turn_0", status } },
          { type: "turn.completed", data: { sequence: 0, turnId: "turn_0" } },
          {
            type: "session.waiting",
            data: { continuationToken: "session-id", wait: "next-user-message" },
          },
        ],
      ]);
      const sessionId = await createSession(adapter);
      const { client, notifications } = acpClient();
      await adapter.prompt(textPrompt(sessionId), client, new AbortController().signal);
      const statuses = notifications
        .map(
          ({ params }) => (params as { update: { status?: string; toolCallId?: string } }).update,
        )
        .filter((update) => update.toolCallId === "c")
        .map((update) => update.status);
      expect(statuses).toEqual([
        "pending",
        "in_progress",
        status === "completed" ? "completed" : "failed",
      ]);
    },
  );

  it("ends a running task call with its failed turn", async () => {
    const at = { sequence: 0, stepIndex: 0, turnId: "turn_0" };
    const action = {
      callId: "call_1",
      input: {},
      kind: "tool-call" as const,
      toolName: "research",
    };
    // Tasks a failed turn leaves running are cancelled after its response ends.
    const { adapter } = adapterWith([
      [
        { type: "turn.started", data: { sequence: 0, turnId: "turn_0" } },
        { type: "actions.requested", data: { ...at, actions: [action] } },
        {
          type: "task.started",
          data: {
            callId: "call_1",
            kind: "tool",
            name: "research",
            taskId: "task_1",
            turnId: "turn_0",
          },
        },
        {
          type: "action.result",
          data: {
            ...at,
            result: {
              callId: "call_1",
              kind: "tool-result",
              output: "Started task task_1.",
              toolName: "research",
            },
            status: "completed",
          },
        },
        { type: "turn.failed", data: { ...at, code: "MODEL_CALL_FAILED", message: "boom" } },
        {
          type: "session.waiting",
          data: { continuationToken: "session-id", wait: "next-user-message" },
        },
      ],
    ]);
    const sessionId = await createSession(adapter);
    const { client, notifications } = acpClient();

    await expect(
      adapter.prompt(textPrompt(sessionId), client, new AbortController().signal),
    ).rejects.toThrow("boom");

    const statuses = notifications
      .map(({ params }) => (params as { update: { status?: string; toolCallId?: string } }).update)
      .filter((update) => update.toolCallId === "call_1")
      .map((update) => update.status);
    expect(statuses).toEqual(["pending", "in_progress", "failed"]);
  });
});
