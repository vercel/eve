import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { Client } from "#client/client.js";
import type { CreatedClientSession, CreatedIdleClientSession } from "#client/sessions.js";
import type { SendTurnInput } from "#client/types.js";
import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/message.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Client.sessions", () => {
  it("preserves an inbox handle through creation and a finite snapshot", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ sessionId: "session_1", inbox: "created_handle" }))
      .mockResolvedValueOnce(
        new Response("", {
          headers: {
            [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
            "x-eve-stream-tail-index": "-1",
          },
        }),
      );
    const client = new Client({ host: "https://eve.test" });
    const { session } = await client.sessions.create();
    const snapshot = await session.snapshot();
    const restored = client.sessions.attach(snapshot.session.sessionId, snapshot.session);

    expect(restored.state.inbox).toBe("created_handle");
  });

  it("uses the ready prewarm handle on the next send without another client lookup", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, status: "ready", inbox: "prepared_handle" }))
      .mockResolvedValueOnce(Response.json({ sessionId: "session_1", deliveryId: "delivery_1" }));
    const session = new Client({ host: "https://eve.test" }).sessions.attach("session_1");

    await session.prewarm();
    await session.send("Continue the conversation.");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).inbox).toBe("prepared_handle");
  });

  it("does not replace a newer send handle when an earlier prewarm finishes late", async () => {
    let finishPrewarm: ((response: Response) => void) | undefined;
    const prewarmed = new Promise<Response>((resolve) => {
      finishPrewarm = resolve;
    });
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => prewarmed)
      .mockResolvedValueOnce(
        Response.json({ sessionId: "session_1", deliveryId: "delivery_1", inbox: "new_handle" }),
      );
    const session = new Client({ host: "https://eve.test" }).sessions.attach("session_1");

    const preparing = session.prewarm();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    await session.send("Send while preparation is running.");
    finishPrewarm!(Response.json({ ok: true, status: "ready", inbox: "old_handle" }));
    await preparing;

    expect(session.state.inbox).toBe("new_handle");
  });

  it("carries the refreshed inbox handle across sends and restored session state", async () => {
    const hints: Array<string | null> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      hints.push(JSON.parse(String(init?.body)).inbox ?? null);
      expect(new Headers(init?.headers).has("x-eve-inbox")).toBe(false);
      return Response.json({
        sessionId: "session_1",
        deliveryId: `delivery_${hints.length}`,
        inbox: `handle_${hints.length}`,
      });
    });
    const client = new Client({ host: "https://eve.test" });
    const session = client.sessions.attach("session_1");
    await session.send("Alice starts the conversation.");
    await session.send("Bob follows up.");
    const restored = client.sessions.attach(session.state.sessionId, session.state);
    await restored.send("Alice continues after reopening it.");
    expect(hints).toEqual([null, "handle_1", "handle_2"]);
    expect(restored.state.inbox).toBe("handle_3");
  });

  it("creates a session without starting a turn or opening its stream", async () => {
    const requests: Array<{ readonly body?: string; readonly url: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      requests.push({ body: init?.body as string | undefined, url: String(request) });
      return Response.json(
        { ok: true, sessionId: "wrun_prewarmer", status: "accepted" },
        { status: 202 },
      );
    });
    const client = new Client({ host: "https://eve.test" });

    const created = await client.sessions.create();
    expectTypeOf(created).toEqualTypeOf<CreatedIdleClientSession>();
    const { session } = created;

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/eve/v1/session");
    expect(requests[0]!.body).toBeUndefined();
    expect(session.state).toEqual({ sessionId: "wrun_prewarmer", streamIndex: 0 });
  });

  it("returns structured output when fetch instrumentation clones the live stream", async () => {
    const events = [
      { type: "result.completed", data: { result: { answer: "child-result" } } },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ];
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streamSignal: AbortSignal | undefined;
    let traceBody: Promise<string> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if (init?.method === "POST") {
        return Response.json({ sessionId: "child-session" }, { status: 202 });
      }
      streamSignal = init?.signal ?? undefined;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
            controller.enqueue(
              new TextEncoder().encode(
                events.map((event) => JSON.stringify(event)).join("\n") + "\n",
              ),
            );
            streamSignal?.addEventListener("abort", () => controller.error(streamSignal?.reason));
          },
        }),
        { headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION } },
      );
      traceBody = response
        .clone()
        .text()
        .catch(() => "");
      return response;
    });
    const client = new Client({ host: "https://eve.test" });
    const { response, session } = await client.sessions.create({
      message: "Return a structured answer.",
      outputSchema: { type: "object", properties: { answer: { type: "string" } } },
    });
    const settled = vi.fn();
    const result = response.result().then(settled);
    try {
      await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
      expect(settled).toHaveBeenCalledWith(
        expect.objectContaining({ data: { answer: "child-result" }, status: "waiting" }),
      );
      expect(streamSignal?.aborted).toBe(true);
      expect(session.state.streamIndex).toBe(events.length);
    } finally {
      source?.error(new DOMException("Test cleanup", "AbortError"));
      await Promise.all([result, traceBody]);
    }
  });

  it("creates explicitly, streams by ID, and keeps the fixed session state", async () => {
    const requests: Array<{ readonly body?: string; readonly url: string }> = [];
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (request, init) => {
        requests.push({ body: init?.body as string | undefined, url: String(request) });
        return Response.json(
          { ok: true, sessionId: "wrun_A", status: "accepted" },
          { status: 202 },
        );
      })
      .mockImplementationOnce(async (request) => {
        requests.push({ url: String(request) });
        return new Response(
          `${JSON.stringify({ data: { reason: "completed" }, type: "session.completed" })}\n`,
          {
            headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
          },
        );
      });
    const client = new Client({ host: "https://eve.test" });

    const input: SendTurnInput<{ answer: string }> = { message: "hello" };
    const created = await client.sessions.create(input);
    expectTypeOf(created).toEqualTypeOf<CreatedClientSession<{ answer: string }>>();
    const { response, session } = created;
    await response.result();

    expect(new URL(requests[0]!.url).pathname).toBe("/eve/v1/session");
    expect(JSON.parse(requests[0]!.body!)).toEqual({ message: "hello" });
    expect(new URL(requests[1]!.url).pathname).toBe("/eve/v1/session/wrun_A/stream");
    expect(session.state).toEqual({ sessionId: "wrun_A", streamIndex: 1 });
  });

  it("attaches without I/O and sends every operation through ID-only routes", async () => {
    const requests: Array<{ readonly body?: string; readonly url: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = String(request);
      requests.push({ body: init?.body as string | undefined, url });
      const path = new URL(url).pathname;
      if (path === "/eve/v1/session/wrun_A") {
        return Response.json(
          { ok: true, sessionId: "wrun_A", status: "accepted", deliveryId: "delivery_1" },
          { status: 202 },
        );
      }
      if (path.endsWith("/cancel")) {
        return Response.json({ ok: true, sessionId: "wrun_A", status: "accepted" });
      }
      if (path.endsWith("/compact") || path.endsWith("/clear")) {
        return Response.json(
          { ok: true, sessionId: "wrun_A", status: "accepted" },
          { status: 202 },
        );
      }
      return Response.json({ ok: true, previousSessionId: "wrun_A", status: "reset" });
    });
    const client = new Client({ host: "https://eve.test" });

    const session = client.sessions.attach("wrun_A");
    expect(requests).toHaveLength(0);
    await session.send("follow-up");
    await session.cancel();
    await session.compact();
    await session.clear();
    await session.reset({ reason: "fresh start" });

    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/eve/v1/session/wrun_A",
      "/eve/v1/session/wrun_A/cancel",
      "/eve/v1/session/wrun_A/compact",
      "/eve/v1/session/wrun_A/clear",
      "/eve/v1/session/wrun_A/reset",
    ]);
    expect(JSON.parse(requests[0]!.body!)).toEqual({ message: "follow-up" });
    expect(JSON.parse(requests[4]!.body!)).toEqual({ reason: "fresh start" });
    expect(session.state).toEqual({ sessionId: "wrun_A", streamIndex: 0 });
  });
});
