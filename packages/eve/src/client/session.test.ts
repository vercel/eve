import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientSession } from "#client/session.js";
import type { SessionState } from "#client/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createSession(
  state: SessionState = { streamIndex: 0 },
  options: { readonly preserveCompletedSessions?: boolean } = {},
) {
  const context: ConstructorParameters<typeof ClientSession>[0] = {
    host: "https://eve.test",
    maxReconnectAttempts: 0,
    preserveCompletedSessions: options.preserveCompletedSessions ?? false,
    async resolveHeaders() {
      return new Headers();
    },
  };

  return new ClientSession(context, state);
}

function createAcceptedResponse() {
  return Response.json(
    {
      continuationToken: "eve:test",
      ok: true,
      sessionId: "session_1",
    },
    { status: 202 },
  );
}

function createStreamResponse(events: readonly unknown[]) {
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

describe("ClientSession", () => {
  it("serializes clientContext when sending a create-session message", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(createAcceptedResponse());
    const session = createSession();

    await session.send({
      clientContext: { selectedWord: "jazz" },
      message: "What word is selected?",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      clientContext: { selectedWord: "jazz" },
      message: "What word is selected?",
    });
  });

  it("serializes clientContext when continuing a session", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(createAcceptedResponse());
    const session = createSession({
      continuationToken: "eve:test",
      sessionId: "session_1",
      streamIndex: 0,
    });

    await session.send({
      clientContext: "approve button visible",
      inputResponses: [{ requestId: "approval_1", optionId: "approve" }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      clientContext: "approve button visible",
      continuationToken: "eve:test",
      inputResponses: [{ requestId: "approval_1", optionId: "approve" }],
    });
  });

  it("bounded-retries continuation readiness without changing session identity", async () => {
    const requests: Array<{ body: unknown; url: string }> = [];
    let attempt = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      requests.push({
        body: JSON.parse(String(init?.body)),
        url:
          typeof request === "string"
            ? request
            : request instanceof URL
              ? request.href
              : request.url,
      });
      attempt += 1;
      if (attempt === 1) {
        return Response.json(
          { code: "session_not_ready", error: "Session is not ready.", ok: false },
          { headers: { "cache-control": "no-store" }, status: 425 },
        );
      }
      return Response.json({ ok: true, sessionId: "session_1" });
    });
    const session = createSession({
      continuationToken: "eve:existing",
      sessionId: "session_1",
      streamIndex: 7,
    });

    const response = await session.send("follow-up");

    expect(response.sessionId).toBe("session_1");
    expect(session.state).toEqual({
      continuationToken: "eve:existing",
      sessionId: "session_1",
      streamIndex: 7,
    });
    expect(requests).toEqual([
      {
        body: { continuationToken: "eve:existing", message: "follow-up" },
        url: "https://eve.test/eve/v1/session/session_1",
      },
      {
        body: { continuationToken: "eve:existing", message: "follow-up" },
        url: "https://eve.test/eve/v1/session/session_1",
      },
    ]);
  });

  it("rejects clientContext-only sends", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(createAcceptedResponse());
    const session = createSession({
      continuationToken: "eve:test",
      sessionId: "session_1",
      streamIndex: 0,
    });

    await expect(
      session.send({
        clientContext: { selectedWord: "jazz" },
      }),
    ).rejects.toThrow("Session.send requires a non-empty message, inputResponses, or both.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("continues the session after consuming through session.waiting", async () => {
    const requests: Array<{ body?: unknown; method: string; url: string }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url =
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      const method = init?.method ?? "GET";
      requests.push({
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        method,
        url,
      });

      if (method === "POST") {
        return createAcceptedResponse();
      }

      return createStreamResponse([
        { type: "session.waiting", data: { wait: "next-user-message" } },
      ]);
    });
    const session = createSession();

    const first = await session.send("first");
    for await (const _event of first) {
      // Drain the stream so ClientSession can advance its cursor.
    }
    await session.send("second");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const postRequests = requests.filter((request) => request.method === "POST");
    expect(new URL(postRequests[1]!.url).pathname).toBe("/eve/v1/session/session_1");
    expect(postRequests[1]!.body).toEqual({
      continuationToken: "eve:test",
      message: "second",
    });
  });

  it("cancels a parked stream after collecting its result", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ type: "session.waiting", data: { wait: "next-user-message" } })}\n`,
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return createAcceptedResponse();
      }

      return new Response(stream);
    });
    const session = createSession();

    const result = await (await session.send("first")).result();

    expect(result.status).toBe("waiting");
    expect(cancelled).toBe(true);
  });

  it("resets the session by default after consuming through session.completed", async () => {
    const requests: Array<{ body?: unknown; method: string; url: string }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url =
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      const method = init?.method ?? "GET";
      requests.push({
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        method,
        url,
      });

      if (method === "POST") {
        return createAcceptedResponse();
      }

      return createStreamResponse([{ type: "session.completed", data: {} }]);
    });
    const session = createSession();

    await (await session.send("first")).result();
    await session.send("second");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const postRequests = requests.filter((request) => request.method === "POST");
    expect(new URL(postRequests[1]!.url).pathname).toBe("/eve/v1/session");
    expect(postRequests[1]!.body).toEqual({
      message: "second",
    });
  });

  it("continues the session after session.completed when configured", async () => {
    const requests: Array<{ body?: unknown; method: string; url: string }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url =
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      const method = init?.method ?? "GET";
      requests.push({
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        method,
        url,
      });

      if (method === "POST") {
        return createAcceptedResponse();
      }

      return createStreamResponse([{ type: "session.completed", data: {} }]);
    });
    const session = createSession({ streamIndex: 0 }, { preserveCompletedSessions: true });

    await (await session.send("first")).result();
    await session.send("second");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const postRequests = requests.filter((request) => request.method === "POST");
    expect(new URL(postRequests[1]!.url).pathname).toBe("/eve/v1/session/session_1");
    expect(postRequests[1]!.body).toEqual({
      continuationToken: "eve:test",
      message: "second",
    });
  });

  it("returns input requests emitted during the consumed turn", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return createAcceptedResponse();
      }

      return createStreamResponse([
        {
          type: "input.requested",
          data: {
            requests: [
              {
                action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "bash" },
                prompt: "Approve?",
                requestId: "approval_1",
              },
            ],
            sequence: 1,
            stepIndex: 0,
            turnId: "turn_1",
          },
        },
        { type: "session.waiting", data: { wait: "next-user-message" } },
      ]);
    });
    const session = createSession();

    const result = await (await session.send("first")).result();

    expect(result.inputRequests.map((request) => request.requestId)).toEqual(["approval_1"]);
  });

  it("snapshots the current durable tail without waiting for a continuable session", async () => {
    const events = [
      {
        type: "message.completed",
        data: {
          message: "Ready for the next question.",
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        events,
        state: {
          continuationToken: "eve:test",
          sessionId: "session_1",
          streamIndex: 12,
        },
      }),
    );
    const session = createSession({
      continuationToken: "eve:test",
      sessionId: "session_1",
      streamIndex: 10,
    });

    const snapshot = await session.snapshot({ startIndex: 10 });

    expect(snapshot).toEqual({
      events,
      state: {
        continuationToken: "eve:test",
        sessionId: "session_1",
        streamIndex: 12,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/eve/v1/session/session_1/snapshot?startIndex=10",
    );
  });

  it("preserves client continuation custody while advancing from a server snapshot", async () => {
    const events = [
      { type: "message.completed", data: { message: "first" } },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        events,
        state: {
          sessionId: "session_1",
          streamIndex: 12,
        },
      }),
    );
    const session = createSession({
      continuationToken: "eve:client-owned",
      sessionId: "session_1",
      streamIndex: 10,
    });

    const snapshot = await session.snapshot();

    expect(snapshot).toEqual({
      events,
      state: {
        continuationToken: "eve:client-owned",
        sessionId: "session_1",
        streamIndex: 12,
      },
    });
    expect(session.state).toEqual(snapshot.state);
  });

  it("streams one live turn and settles while the parent remains continuable", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const events = [
      {
        type: "message.completed",
        data: {
          message: "Ready for the next question.",
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(body));
    const session = createSession({
      continuationToken: "eve:test",
      sessionId: "session_1",
      streamIndex: 10,
    });

    const received = [];
    for await (const event of session.streamTurn({ startIndex: 10 })) {
      received.push(event);
    }

    expect(received).toEqual(events);
    expect(cancelled).toBe(true);
    expect(session.state).toEqual({
      continuationToken: "eve:test",
      sessionId: "session_1",
      streamIndex: 12,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/eve/v1/session/session_1/stream?startIndex=10",
    );
  });

  it("rejects a live turn that disconnects before its boundary without advancing the cursor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      createStreamResponse([{ type: "turn.started", data: { sequence: 1, turnId: "turn_1" } }]),
    );
    const initialState = {
      continuationToken: "eve:test",
      sessionId: "session_1",
      streamIndex: 10,
    };
    const session = createSession(initialState);

    await expect(
      (async () => {
        for await (const _event of session.streamTurn({ startIndex: 10 })) {
          void _event;
        }
      })(),
    ).rejects.toThrow(/boundary/i);
    expect(session.state).toEqual(initialState);
  });
});
