import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Client,
  ClientError,
  type AgentInfoResult,
  type HandleMessageStreamEvent,
} from "../src/client/index.js";
import {
  EVE_SESSION_ID_HEADER,
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createResultCompletedEvent,
  createSessionCompletedEvent,
  createSessionFailedEvent,
  createSessionWaitingEvent,
  createTurnCompletedEvent,
  createTurnStartedEvent,
} from "../src/protocol/message.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createControlledStreamResponse(): {
  close(): void;
  error(error: Error): void;
  pushEvent(event: unknown): void;
  response: Response;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  return {
    close() {
      controller?.close();
    },
    error(error) {
      controller?.error(error);
    },
    pushEvent(event) {
      controller?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    },
    response: new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
        },
      }),
    ),
  };
}

function createStartedMessageResponse(sessionId: string, continuationToken: string): Response {
  return new Response(JSON.stringify({ continuationToken, ok: true, sessionId }), {
    headers: {
      "content-type": "application/json",
      [EVE_SESSION_ID_HEADER]: sessionId,
    },
    status: 202,
  });
}

function createResumedMessageResponse(continuationToken: string): Response {
  return new Response(JSON.stringify({ continuationToken, ok: true }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function createEagerStreamResponse(events: readonly unknown[]): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
        controller.close();
      },
    }),
  );
}

function singleTurnEvents(input: {
  message: string;
  sequence: number;
  turnId: string;
}): HandleMessageStreamEvent[] {
  return [
    createTurnStartedEvent({ sequence: input.sequence, turnId: input.turnId }),
    createMessageReceivedEvent({
      message: input.message,
      sequence: input.sequence,
      turnId: input.turnId,
    }),
    createMessageCompletedEvent({
      message: `Reply: ${input.message}`,
      sequence: input.sequence,
      stepIndex: 0,
      turnId: input.turnId,
    }),
    createTurnCompletedEvent({ sequence: input.sequence, turnId: input.turnId }),
    createSessionWaitingEvent(),
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// health()
// ---------------------------------------------------------------------------

describe("Client.health", () => {
  it("returns the health response on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ ok: true, status: "ready", workflowId: "wf_001" }),
    );

    const client = new Client({ host: "http://localhost:3000" });
    const result = await client.health();

    expect(result).toEqual({ ok: true, status: "ready", workflowId: "wf_001" });
  });

  it("throws ClientError on non-200 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"ok":false,"error":"Unauthorized"}', { status: 401 }),
    );

    const client = new Client({ host: "http://localhost:3000" });

    try {
      await client.health();
      expect.unreachable("Expected ClientError to be thrown.");
    } catch (error) {
      expect(error).toBeInstanceOf(ClientError);
      expect((error as ClientError).status).toBe(401);
      expect((error as ClientError).body).toContain("Unauthorized");
    }
  });

  it("sends bearer auth header when configured with a static token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, status: "ready", workflowId: "wf_001" }));

    const client = new Client({
      auth: { bearer: "my-token" },
      host: "http://localhost:3000",
    });
    await client.health();

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer my-token");
  });

  it("resolves bearer auth via callback on each request", async () => {
    let callCount = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(Response.json({ ok: true, status: "ready", workflowId: "wf_001" })),
      );

    const client = new Client({
      auth: {
        bearer: () => {
          callCount += 1;
          return `token_${callCount}`;
        },
      },
      host: "http://localhost:3000",
    });

    await client.health();
    await client.health();

    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get("authorization")).toBe("Bearer token_1");
    expect(secondHeaders.get("authorization")).toBe("Bearer token_2");
    expect(callCount).toBe(2);
  });

  it("sends basic auth header", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, status: "ready", workflowId: "wf_001" }));

    const client = new Client({
      auth: { basic: { password: "secret", username: "admin" } },
      host: "http://localhost:3000",
    });
    await client.health();

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${btoa("admin:secret")}`);
  });

  it("sends custom headers", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, status: "ready", workflowId: "wf_001" }));

    const client = new Client({
      headers: { "x-custom": "value" },
      host: "http://localhost:3000",
    });
    await client.health();

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-custom")).toBe("value");
  });
});

// ---------------------------------------------------------------------------
// info()
// ---------------------------------------------------------------------------

describe("Client.info", () => {
  it("fetches the agent info payload from the info route", async () => {
    const payload = {
      agent: {
        agentRoot: "/tmp/weather-agent/agent",
        appRoot: "/tmp/weather-agent",
        model: {
          id: "gpt-5",
        },
        name: "Weather Agent",
      },
      capabilities: { devRoutes: true },
      channels: {
        authored: [],
        available: [],
        disabledFramework: [],
        framework: [],
      },
      connections: [],
      diagnostics: {
        discoveryErrors: 0,
        discoveryWarnings: 0,
      },
      hooks: [],
      instructions: {
        dynamic: [],
        static: {
          logicalPath: "agent/instructions.md",
          markdown: "You are a weather assistant.",
          name: "instructions",
          sourceKind: "markdown",
        },
      },
      kind: "eve-agent-info",
      mode: "development",
      sandbox: null,
      schedules: [],
      skills: {
        dynamic: [],
        static: [],
      },
      subagents: {
        local: [],
        total: 0,
      },
      tools: {
        authored: [
          {
            description: "Get the weather.",
            hasAuth: false,
            hasExecute: true,
            hasModelOutputProjection: false,
            hasOutputSchema: false,
            inputSchema: { type: "object" },
            logicalPath: "agent/tools/get_weather.ts",
            name: "get_weather",
            origin: "authored",
            outputSchema: null,
            replacesFrameworkTool: false,
            requiresApproval: false,
            sourceKind: "module",
          },
        ],
        available: [],
        disabledFramework: [],
        dynamic: [],
        framework: [],
        reserved: [],
      },
      version: 1,
      workflow: {
        enabled: false,
        toolName: "Workflow",
      },
      workspace: {
        resourceRoot: null,
        rootEntries: [],
      },
    } satisfies AgentInfoResult;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(payload));

    const client = new Client({ host: "http://localhost:3000" });
    const result = await client.info();

    expect(result).toEqual(payload);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://localhost:3000/eve/v1/info");
  });

  it("throws ClientError on non-200 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"error":"Unauthorized"}', { status: 401 }),
    );

    const client = new Client({ host: "http://localhost:3000" });

    try {
      await client.info();
      expect.unreachable("Expected ClientError to be thrown.");
    } catch (error) {
      expect(error).toBeInstanceOf(ClientError);
      expect((error as ClientError).status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// session.send() — await res.result()
// ---------------------------------------------------------------------------

describe("Session.send (result)", () => {
  it("sends the first message and returns the result", async () => {
    const events = singleTurnEvents({ message: "Hello", sequence: 1, turnId: "turn_001" });

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_001", "http:session_001"))
      .mockResolvedValueOnce(createEagerStreamResponse(events));

    const session = new Client({ host: "http://localhost:3000" }).session();
    const res = await session.send("Hello");

    expect(res.sessionId).toBe("session_001");

    const result = await res.result();

    expect(result.message).toBe("Reply: Hello");
    expect(result.sessionId).toBe("session_001");
    expect(result.status).toBe("waiting");
    expect(result.events).toEqual(events);
  });

  it("sends continuation token on follow-up messages", async () => {
    const firstEvents = singleTurnEvents({ message: "Hello", sequence: 1, turnId: "turn_001" });
    const secondEvents = singleTurnEvents({
      message: "Follow up",
      sequence: 2,
      turnId: "turn_002",
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_001", "http:session_001"))
      .mockResolvedValueOnce(createEagerStreamResponse(firstEvents))
      .mockResolvedValueOnce(createResumedMessageResponse("http:session_001"))
      .mockResolvedValueOnce(createEagerStreamResponse(secondEvents));

    const session = new Client({ host: "http://localhost:3000" }).session();
    await (await session.send("Hello")).result();
    const second = await (await session.send("Follow up")).result();

    expect(second.message).toBe("Reply: Follow up");
    expect(second.status).toBe("waiting");

    const secondPostBody = JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(secondPostBody.continuationToken).toBe("http:session_001");
    expect(secondPostBody.message).toBe("Follow up");

    const secondStreamUrl = String(fetchMock.mock.calls[3]?.[0]);
    expect(secondStreamUrl).toContain("startIndex=5");
  });

  it("returns status 'failed' when the session fails without throwing", async () => {
    const events: HandleMessageStreamEvent[] = [
      createTurnStartedEvent({ sequence: 1, turnId: "turn_001" }),
      createSessionFailedEvent({
        code: "internal_error",
        message: "Something went wrong",
        sessionId: "session_001",
      }),
    ];

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_001", "http:session_001"))
      .mockResolvedValueOnce(createEagerStreamResponse(events));

    const session = new Client({ host: "http://localhost:3000" }).session();
    const result = await (await session.send("Hello")).result();

    expect(result.status).toBe("failed");
    expect(result.message).toBeUndefined();
    expect(result.events).toEqual(events);
  });

  it("returns status 'completed' when the session completes", async () => {
    const events: HandleMessageStreamEvent[] = [
      createTurnStartedEvent({ sequence: 1, turnId: "turn_001" }),
      createMessageCompletedEvent({
        message: "Done",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_001",
      }),
      createTurnCompletedEvent({ sequence: 1, turnId: "turn_001" }),
      createSessionCompletedEvent(),
    ];

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_001", "http:session_001"))
      .mockResolvedValueOnce(createEagerStreamResponse(events));

    const session = new Client({ host: "http://localhost:3000" }).session();
    const result = await (await session.send("Do a task")).result();

    expect(result.status).toBe("completed");
    expect(result.message).toBe("Done");
  });

  it("sends outputSchema and exposes completed structured data", async () => {
    const outputSchema = {
      properties: { title: { type: "string" } },
      required: ["title"],
      type: "object",
    } as const;
    const events: HandleMessageStreamEvent[] = [
      createTurnStartedEvent({ sequence: 1, turnId: "turn_001" }),
      createMessageReceivedEvent({
        message: "Summarize",
        sequence: 1,
        turnId: "turn_001",
      }),
      createMessageCompletedEvent({
        message: "Done",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_001",
      }),
      createResultCompletedEvent({
        result: { title: "Done" },
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_001",
      }),
      createTurnCompletedEvent({ sequence: 1, turnId: "turn_001" }),
      createSessionWaitingEvent(),
    ];

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_001", "http:session_001"))
      .mockResolvedValueOnce(createEagerStreamResponse(events));

    const session = new Client({ host: "http://localhost:3000" }).session();
    const response = await session.send<{ title: string }>({ message: "Summarize", outputSchema });
    const result = await response.result();

    expect(result.data).toEqual({ title: "Done" });
    const postBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(postBody.outputSchema).toEqual(outputSchema);
  });

  it("resets session state after session.completed", async () => {
    const firstEvents: HandleMessageStreamEvent[] = [
      createTurnStartedEvent({ sequence: 1, turnId: "turn_001" }),
      createMessageCompletedEvent({
        message: "Done",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_001",
      }),
      createSessionCompletedEvent(),
    ];
    const secondEvents = singleTurnEvents({
      message: "New conversation",
      sequence: 1,
      turnId: "turn_001",
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_001", "http:session_001"))
      .mockResolvedValueOnce(createEagerStreamResponse(firstEvents))
      .mockResolvedValueOnce(createStartedMessageResponse("session_002", "http:session_002"))
      .mockResolvedValueOnce(createEagerStreamResponse(secondEvents));

    const session = new Client({ host: "http://localhost:3000" }).session();
    await (await session.send("Task")).result();
    await (await session.send("New conversation")).result();

    const secondPostBody = JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(secondPostBody.continuationToken).toBeUndefined();
  });

  it("throws ClientError when the POST fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"ok":false,"error":"Bad request"}', { status: 400 }),
    );

    const session = new Client({ host: "http://localhost:3000" }).session();

    await expect(session.send("Hello")).rejects.toThrow(ClientError);
  });
});

// ---------------------------------------------------------------------------
// session.send() — for await (stream)
// ---------------------------------------------------------------------------

describe("Session.send (stream)", () => {
  it("yields events one at a time", async () => {
    const stream = createControlledStreamResponse();

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_001", "http:session_001"))
      .mockResolvedValueOnce(stream.response);

    const session = new Client({ host: "http://localhost:3000" }).session();
    const res = await session.send("Hello");
    const collected: HandleMessageStreamEvent[] = [];

    const iterationPromise = (async () => {
      for await (const event of res) {
        collected.push(event);
      }
    })();

    setTimeout(() => {
      stream.pushEvent(createTurnStartedEvent({ sequence: 1, turnId: "turn_001" }));
      stream.pushEvent(
        createMessageCompletedEvent({
          message: "Hi",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_001",
        }),
      );
      stream.pushEvent(createSessionWaitingEvent());
    }, 0);

    await iterationPromise;

    expect(collected).toHaveLength(3);
    expect(collected[0]?.type).toBe("turn.started");
    expect(collected[1]?.type).toBe("message.completed");
    expect(collected[2]?.type).toBe("session.waiting");
  });

  it("provides sessionId before streaming begins", async () => {
    const stream = createControlledStreamResponse();

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_001", "http:session_001"))
      .mockResolvedValueOnce(stream.response);

    const session = new Client({ host: "http://localhost:3000" }).session();
    const res = await session.send("Hello");

    expect(res.sessionId).toBe("session_001");

    setTimeout(() => {
      stream.pushEvent(createSessionWaitingEvent());
    }, 0);

    for await (const _ of res) {
      // Consume stream.
    }
  });

  it("throws when consumed twice", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_001", "http:session_001"))
      .mockResolvedValueOnce(
        createEagerStreamResponse(
          singleTurnEvents({ message: "Hello", sequence: 1, turnId: "turn_001" }),
        ),
      );

    const session = new Client({ host: "http://localhost:3000" }).session();
    const res = await session.send("Hello");

    await res.result();

    expect(() => {
      res[Symbol.asyncIterator]();
    }).toThrow("already been consumed");
  });
});

// ---------------------------------------------------------------------------
// Stream reconnection
// ---------------------------------------------------------------------------

describe("Session.send (reconnection)", () => {
  it("reconnects when the stream disconnects mid-turn", async () => {
    const firstStream = createControlledStreamResponse();
    const reconnectEvents: HandleMessageStreamEvent[] = [
      createMessageReceivedEvent({ message: "Hello", sequence: 1, turnId: "turn_001" }),
      createMessageCompletedEvent({
        message: "Reply",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_001",
      }),
      createTurnCompletedEvent({ sequence: 1, turnId: "turn_001" }),
      createSessionWaitingEvent(),
    ];

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_001", "http:session_001"))
      .mockResolvedValueOnce(firstStream.response)
      .mockResolvedValueOnce(createEagerStreamResponse(reconnectEvents));

    const session = new Client({ host: "http://localhost:3000" }).session();
    const res = await session.send("Hello");

    setTimeout(() => {
      firstStream.pushEvent(createTurnStartedEvent({ sequence: 1, turnId: "turn_001" }));
      firstStream.error(new TypeError("terminated"));
    }, 0);

    const result = await res.result();

    expect(result.message).toBe("Reply");
    expect(result.status).toBe("waiting");
    expect(result.events).toHaveLength(5);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const reconnectUrl = String(fetchMock.mock.calls[2]?.[0]);
    expect(reconnectUrl).toContain("startIndex=1");
  });
});

// ---------------------------------------------------------------------------
// Client.stream()
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session state and resumption
// ---------------------------------------------------------------------------

describe("Session state", () => {
  it("exposes state after a turn completes", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_001", "http:session_001"))
      .mockResolvedValueOnce(
        createEagerStreamResponse(
          singleTurnEvents({ message: "Hello", sequence: 1, turnId: "turn_001" }),
        ),
      );

    const session = new Client({ host: "http://localhost:3000" }).session();

    expect(session.state).toEqual({ streamIndex: 0 });

    await (await session.send("Hello")).result();

    expect(session.state).toEqual({
      continuationToken: "http:session_001",
      sessionId: "session_001",
      streamIndex: 5,
    });
  });

  it("resumes from a saved SessionState", async () => {
    const events = singleTurnEvents({ message: "I'm back", sequence: 2, turnId: "turn_002" });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createResumedMessageResponse("http:session_001"))
      .mockResolvedValueOnce(createEagerStreamResponse(events));

    const client = new Client({ host: "http://localhost:3000" });
    const session = client.session({
      continuationToken: "http:session_001",
      sessionId: "session_001",
      streamIndex: 5,
    });

    await (await session.send("I'm back")).result();

    const postBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(postBody.continuationToken).toBe("http:session_001");

    const streamUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(streamUrl).toContain("startIndex=5");
  });

  it("resumes from a continuation token string shorthand", async () => {
    const events = singleTurnEvents({ message: "Hello", sequence: 1, turnId: "turn_001" });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("run_001", "http:session_001"))
      .mockResolvedValueOnce(createEagerStreamResponse(events));

    const client = new Client({ host: "http://localhost:3000" });
    const session = client.session("http:session_001");

    await (await session.send("Hello")).result();

    const postBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(postBody.continuationToken).toBe("http:session_001");
  });

  it("allows multiple independent sessions on the same client", async () => {
    const eventsA = singleTurnEvents({ message: "A", sequence: 1, turnId: "turn_a" });
    const eventsB = singleTurnEvents({ message: "B", sequence: 1, turnId: "turn_b" });

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_a", "http:session_a"))
      .mockResolvedValueOnce(createEagerStreamResponse(eventsA))
      .mockResolvedValueOnce(createStartedMessageResponse("session_b", "http:session_b"))
      .mockResolvedValueOnce(createEagerStreamResponse(eventsB));

    const client = new Client({ host: "http://localhost:3000" });
    const sessionA = client.session();
    const sessionB = client.session();

    const resultA = await (await sessionA.send("A")).result();
    const resultB = await (await sessionB.send("B")).result();

    expect(resultA.message).toBe("Reply: A");
    expect(resultB.message).toBe("Reply: B");
    expect(sessionA.state.sessionId).toBe("session_a");
    expect(sessionB.state.sessionId).toBe("session_b");
  });

  it("creating a new session starts a fresh conversation", async () => {
    const firstEvents = singleTurnEvents({ message: "Hello", sequence: 1, turnId: "turn_001" });
    const secondEvents = singleTurnEvents({
      message: "Fresh start",
      sequence: 1,
      turnId: "turn_001",
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_001", "http:session_001"))
      .mockResolvedValueOnce(createEagerStreamResponse(firstEvents))
      .mockResolvedValueOnce(createStartedMessageResponse("session_002", "http:session_002"))
      .mockResolvedValueOnce(createEagerStreamResponse(secondEvents));

    const client = new Client({ host: "http://localhost:3000" });

    const first = client.session();
    await (await first.send("Hello")).result();

    const second = client.session();
    await (await second.send("Fresh start")).result();

    const secondPostBody = JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(secondPostBody.continuationToken).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Session.stream()
// ---------------------------------------------------------------------------

describe("Session.stream", () => {
  it("throws when no session ID is available", () => {
    const session = new Client({ host: "http://localhost:3000" }).session();

    expect(() => session.stream()).toThrow("no session ID");
  });

  it("uses the session sessionId and streamIndex", async () => {
    const events: HandleMessageStreamEvent[] = [
      createMessageCompletedEvent({
        message: "Hi",
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_002",
      }),
      createSessionWaitingEvent(),
    ];

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createEagerStreamResponse(events));

    const client = new Client({ host: "http://localhost:3000" });
    const session = client.session({
      continuationToken: "http:session_001",
      sessionId: "session_001",
      streamIndex: 10,
    });

    const collected: HandleMessageStreamEvent[] = [];
    for await (const event of session.stream()) {
      collected.push(event);
    }

    expect(collected).toEqual(events);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("session_001/stream");
    expect(url).toContain("startIndex=10");
  });
});

// ---------------------------------------------------------------------------
// Auth — async bearer callback
// ---------------------------------------------------------------------------

describe("Client auth (async bearer)", () => {
  it("resolves auth before each request in send", async () => {
    let tokenCounter = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createStartedMessageResponse("session_001", "http:session_001"))
      .mockResolvedValueOnce(
        createEagerStreamResponse(
          singleTurnEvents({ message: "Hello", sequence: 1, turnId: "turn_001" }),
        ),
      );

    const client = new Client({
      auth: {
        bearer: async () => {
          tokenCounter += 1;
          return `oidc_token_${tokenCounter}`;
        },
      },
      host: "http://localhost:3000",
    });

    await (await client.session().send("Hello")).result();

    expect(tokenCounter).toBe(2);
    const postHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const streamHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(postHeaders.get("authorization")).toBe("Bearer oidc_token_1");
    expect(streamHeaders.get("authorization")).toBe("Bearer oidc_token_2");
  });
});

// ---------------------------------------------------------------------------
// Auth — basic with dynamic password
// ---------------------------------------------------------------------------

describe("Client auth (basic with callback)", () => {
  it("resolves password callback for basic auth", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, status: "ready", workflowId: "wf_001" }));

    const client = new Client({
      auth: {
        basic: {
          password: async () => "dynamic-secret",
          username: "admin",
        },
      },
      host: "http://localhost:3000",
    });

    await client.health();

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${btoa("admin:dynamic-secret")}`);
  });
});

// ---------------------------------------------------------------------------
// Custom headers — dynamic resolver
// ---------------------------------------------------------------------------

describe("Client headers (dynamic resolver)", () => {
  it("resolves the headers callback before every request", async () => {
    let counter = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(Response.json({ ok: true, status: "ready", workflowId: "wf_001" })),
      );

    const client = new Client({
      headers: async () => {
        counter += 1;
        return { "x-bypass-token": `token_${counter}` };
      },
      host: "http://localhost:3000",
    });

    await client.health();
    await client.health();

    expect(counter).toBe(2);
    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get("x-bypass-token")).toBe("token_1");
    expect(secondHeaders.get("x-bypass-token")).toBe("token_2");
  });
});
