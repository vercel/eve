import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/message.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Client.sessions", () => {
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

    const { response, session } = await client.sessions.create({ message: "hello" });
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
