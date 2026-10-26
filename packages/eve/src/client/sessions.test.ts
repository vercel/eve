import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { Client } from "#client/client.js";
import type { CreatedClientSession, CreatedIdleClientSession } from "#client/sessions.js";
import type { SendTurnInput } from "#client/types.js";
import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/session-http.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { encodeTestLine } from "#internal/testing/events.js";
import { encodeLine } from "#protocol/session-events/envelope.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Client.sessions", () => {
  it("creates a session without starting a turn or opening its stream", async () => {
    const requests: Array<{ readonly body?: string; readonly url: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      requests.push({ body: init?.body as string | undefined, url: String(request) });
      return Response.json(
        { ok: true, sessionId: "wrun_prewarmer", status: "accepted" },
        { status: 202 },
      );
    });
    const client = new Client({ baseUrl: "https://eve.test" });

    const created = await client.sessions.create();
    expectTypeOf(created).toEqualTypeOf<CreatedIdleClientSession>();
    expect(Object.keys(created)).toEqual(["session"]);
    const { session } = created;

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/eve/v1/session");
    expect(requests[0]!.body).toBeUndefined();
    expect(session.state).toEqual({ sessionId: "wrun_prewarmer", streamIndex: 0 });
  });

  it("returns structured output when fetch instrumentation clones the live stream", async () => {
    const scope = { runId: "run_0", turnId: "turn_0" };
    const events: SessionEvent[] = [
      { type: "session.started", data: {} },
      { type: "delivery.admitted", data: { deliveryId: "delivery_0" } },
      {
        data: { cause: { deliveryId: "delivery_0" }, follows: null, turnId: "turn_0" },
        scope: { turnId: "turn_0" },
        type: "turn.started",
      },
      {
        type: "delivery.consumed",
        data: { deliveryId: "delivery_0", turnId: "turn_0", parts: [] },
      },
      { data: { owner: { turnId: "turn_0" }, runId: "run_0" }, scope, type: "model.requested" },
      {
        data: {
          kind: "result",
          partId: "part_0",
          phase: "reply",
          runId: "run_0",
          value: { answer: "child-result" },
        },
        scope,
        type: "content.completed",
      },
      { data: { outcome: "completed", runId: "run_0" }, scope, type: "model.settled" },
      {
        data: { outcome: "completed", reply: ["part_0"], turnId: "turn_0" },
        scope: { turnId: "turn_0" },
        type: "turn.settled",
      },
      {
        type: "delivery.settled",
        data: { deliveryId: "delivery_0", turnId: "turn_0", outcome: "handled" },
      },
    ];
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streamSignal: AbortSignal | undefined;
    let traceBody: Promise<string> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if (init?.method === "POST") {
        return Response.json(
          { sessionId: "child-session", deliveryId: "delivery_0" },
          { status: 202 },
        );
      }
      streamSignal = init?.signal ?? undefined;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
            controller.enqueue(new TextEncoder().encode(events.map(encodeTestLine).join("")));
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
    const client = new Client({ baseUrl: "https://eve.test" });
    const { delivery, session } = await client.sessions.create({
      message: "Return a structured answer.",
      outputSchema: { type: "object", properties: { answer: { type: "string" } } },
    });
    const settled = vi.fn();
    const result = delivery.result().then(settled);
    try {
      await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
      expect(settled).toHaveBeenCalledWith(
        expect.objectContaining({ data: { answer: "child-result" }, status: "completed" }),
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
          { ok: true, sessionId: "wrun_A", deliveryId: "delivery_0" },
          { status: 202 },
        );
      })
      .mockImplementationOnce(async (request) => {
        requests.push({ url: String(request) });
        return new Response(
          encodeLine({
            at: "2026-10-20T00:00:00.000Z",
            facts: [
              { type: "delivery.admitted", data: { deliveryId: "delivery_0" } },
              { type: "delivery.settled", data: { deliveryId: "delivery_0", outcome: "ignored" } },
              { type: "session.ended", data: { outcome: "completed" } },
            ],
          }),
          { headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION } },
        );
      });
    const client = new Client({ baseUrl: "https://eve.test" });

    const input: SendTurnInput<{ answer: string }> = { message: "hello" };
    const created = await client.sessions.create(input);
    expectTypeOf(created).toEqualTypeOf<CreatedClientSession<{ answer: string }>>();
    const { delivery, session } = created;
    await delivery.result();

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
      return Response.json(
        { ok: true, sessionId: "wrun_A", deliveryId: `delivery_${requests.length}` },
        { status: 202 },
      );
    });
    const client = new Client({ baseUrl: "https://eve.test" });

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

  it("prepares the fixed session with a bodyless POST to its input route", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true, status: "accepted" }, { status: 202 }));
    const session = new Client({ baseUrl: "https://eve.test" }).sessions.attach("session/1", {
      streamIndex: 4,
    });

    await expect(session.prewarm()).resolves.toEqual({ status: "accepted" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://eve.test/eve/v1/session/session%2F1");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(session.state).toEqual({ sessionId: "session/1", streamIndex: 4 });
  });

  it("sends only each control's own fields when options carry extra keys", async () => {
    const requests: Array<{ readonly body?: string; readonly signal?: AbortSignal | null }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      requests.push({ body: init?.body as string | undefined, signal: init?.signal });
      return Response.json(
        { ok: true, sessionId: "wrun_A", deliveryId: `delivery_${requests.length}` },
        { status: 202 },
      );
    });
    const session = new Client({ baseUrl: "https://eve.test" }).sessions.attach("wrun_A");
    const signal = new AbortController().signal;
    const options = { signal, turnId: "turn_1", reason: "fresh start", extra: true };

    await session.cancel(options);
    await session.compact(options);
    await session.clear(options);
    await session.reset(options);

    expect(requests.map(({ body }) => JSON.parse(body!))).toEqual([
      { turnId: "turn_1" },
      {},
      {},
      { reason: "fresh start" },
    ]);
    expect(requests.every((request) => request.signal === signal)).toBe(true);
  });
});
