import { RequestError, type AgentContext } from "#compiled/@agentclientprotocol/sdk/index.js";
import { describe, expect, it, vi } from "vitest";

import { EveAcpAdapter } from "#acp/adapter.js";
import type { SendTurnInput, SessionState } from "#client/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

class FakeClientSession {
  readonly cancel = vi.fn(async () => ({ status: "accepted" }));
  readonly reset = vi.fn(async () => ({ status: "reset" }));
  readonly sends: SendTurnInput[] = [];
  state: SessionState = { streamIndex: 0 };
  readonly #turns: Array<readonly HandleMessageStreamEvent[]>;

  constructor(turns: Array<readonly HandleMessageStreamEvent[]>) {
    this.#turns = turns;
  }

  async send(input: SendTurnInput): Promise<AsyncIterable<HandleMessageStreamEvent>> {
    this.sends.push(input);
    this.state = { ...this.state, sessionId: "eve-session" };
    const events = this.#turns.shift() ?? [];
    return (async function* () {
      for (const event of events) yield event;
    })();
  }
}

function adapterWith(turns: Array<readonly HandleMessageStreamEvent[]> = []) {
  const session = new FakeClientSession(turns);
  const adapter = new EveAcpAdapter({
    appRoot: process.cwd(),
    client: { session: () => session },
    eveVersion: "1.2.3",
    serverUrl: "http://127.0.0.1:2000",
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
      appRoot: process.cwd(),
      client: { session: () => session },
      eveVersion: "1.2.3",
      serverUrl: "https://agent.example.com",
      validateWorkspaceRoot: false,
    });

    await expect(
      adapter.newSession({ cwd: "/a/client/path-that-does-not-exist", mcpServers: [] }),
    ).resolves.toEqual({ sessionId: expect.any(String) });
  });

  it("streams message, reasoning, and tool lifecycle updates in event order", async () => {
    const events: HandleMessageStreamEvent[] = [
      {
        type: "message.appended",
        data: { messageDelta: "Hi", messageSoFar: "Hi", sequence: 1, stepIndex: 0, turnId: "t1" },
      },
      {
        type: "reasoning.appended",
        data: {
          reasoningDelta: "Think",
          reasoningSoFar: "Think",
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
          ],
          sequence: 3,
          stepIndex: 0,
          turnId: "t1",
        },
      },
      {
        type: "action.result",
        data: {
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
      { type: "session.waiting", data: { continuationToken: "secret", wait: "next-user-message" } },
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
      "tool_call_update",
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
        { type: "session.waiting", data: { continuationToken: "one", wait: "next-user-message" } },
      ],
      [{ type: "session.waiting", data: { continuationToken: "two", wait: "next-user-message" } }],
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
        { type: "session.waiting", data: { continuationToken: "one", wait: "next-user-message" } },
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

  it("requests cooperative cancellation and waits for the cancelled boundary", async () => {
    let release!: () => void;
    let observeTurn!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const turnObserved = new Promise<void>((resolve) => (observeTurn = resolve));
    const session = new FakeClientSession([]);
    session.send = vi.fn(async () => {
      session.state = { sessionId: "eve-session", streamIndex: 0 };
      return (async function* () {
        observeTurn();
        yield {
          type: "turn.started",
          data: { sequence: 0, turnId: "turn-1" },
        } as HandleMessageStreamEvent;
        await pending;
        yield {
          type: "turn.cancelled",
          data: { sequence: 1, turnId: "turn-1" },
        } as HandleMessageStreamEvent;
        yield {
          type: "session.waiting",
          data: { continuationToken: "next", wait: "next-user-message" },
        } as HandleMessageStreamEvent;
      })();
    });
    const adapter = new EveAcpAdapter({
      appRoot: process.cwd(),
      client: { session: () => session },
      eveVersion: "1.2.3",
      serverUrl: "http://127.0.0.1:2000",
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

  it("rejects unsupported prompt content instead of dropping it", async () => {
    const { adapter } = adapterWith();
    const sessionId = await createSession(adapter);
    await expect(
      adapter.prompt(
        { prompt: [{ type: "image", data: "a", mimeType: "image/png" }], sessionId },
        acpClient().client,
        new AbortController().signal,
      ),
    ).rejects.toThrow("not supported");
  });
});
