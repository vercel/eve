import { afterEach, describe, expect, it, vi } from "vitest";

import type { InternalSession as Session } from "#channel/session.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";
import { createSessionStreamResponse } from "#eve-channel/request.js";
import { EVE_STREAM_TAIL_INDEX_HEADER } from "#protocol/session-http.js";

afterEach(() => vi.useRealTimers());

const at = "2026-10-09T00:00:00.000Z";
const line = (deliveryId: string) => ({
  at,
  facts: [{ data: { deliveryId }, type: "delivery.admitted" }],
});

/** A session whose stored lines are `lines`; `open` keeps the source open after them. */
function sessionOf(lines: readonly unknown[], options: { readonly open?: boolean } = {}) {
  const starts: number[] = [];
  const follows: (boolean | undefined)[] = [];
  let tailLookups = 0;
  const session = {
    id: "session_1",
    async getLineStream({
      follow,
      startIndex,
    }: {
      readonly follow?: boolean;
      readonly startIndex: number;
    }) {
      starts.push(startIndex);
      follows.push(follow);
      return new ReadableStream<unknown>({
        start(controller) {
          for (const stored of lines.slice(startIndex)) controller.enqueue(stored);
          if (options.open !== true) controller.close();
        },
      });
    },
    async getStreamTailIndex() {
      tailLookups += 1;
      return lines.length - 1;
    },
  };
  return {
    follows,
    session: session as Session,
    starts,
    tailLookups: () => tailLookups,
  };
}

async function records(response: Response): Promise<unknown[]> {
  return (await response.text())
    .split("\n")
    .filter((text) => text.length > 0)
    .map((text) => JSON.parse(text) as unknown);
}

describe("createSessionStreamResponse", () => {
  it("bounds a historical read at the durable tail and asks for it without following", async () => {
    const { follows, session } = sessionOf([line("a"), line("b")], { open: true });
    const response = await createSessionStreamResponse(
      new Request("https://eve.test/eve/v1/session/session_1/stream?follow=false"),
      session,
    );
    expect(response.headers.get(EVE_STREAM_TAIL_INDEX_HEADER)).toBe("1");
    // The second read is the bounded check of the first line's version.
    expect(follows).toEqual([false, false]);
    expect(await records(response)).toEqual([{ $eve: "heartbeat" }, line("a"), line("b")]);
  });

  it("answers a stranded session's follow with a final 409", async () => {
    const { session } = sessionOf([]);
    const stranded: Session = {
      ...session,
      getLineStream: () =>
        Promise.reject(new SessionStrandedError({ eveVersion: "0.0.1" }, "Reset it.")),
    };
    const response = await createSessionStreamResponse(
      new Request("https://eve.test/eve/v1/session/session_1/stream"),
      stranded,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "session_stranded",
      eveVersion: "0.0.1",
    });
  });

  it("serves a stream an earlier eve recorded as v27 lines, keeping stored positions", async () => {
    const v26 = (type: string, data: object) => ({
      data: { sequence: 0, turnId: "turn_0", ...data },
      meta: { at, deliveryIds: ["delivery_1"] },
      type,
    });
    const { session, starts } = sessionOf([
      { data: {}, meta: { at }, type: "session.started" },
      v26("turn.started", {}),
      v26("message.received", { message: "Alice asks." }),
      v26("message.appended", { messageDelta: "Hi", stepIndex: 0 }),
    ]);
    const response = await createSessionStreamResponse(
      new Request("https://eve.test/eve/v1/session/session_1/stream?follow=false&startIndex=2"),
      session,
    );
    expect(response.status).toBe(200);
    // Each v26 line reads in light of those before it, so the read starts at the first.
    expect(starts.at(-1)).toBe(0);
    expect(await records(response)).toEqual([
      { $eve: "heartbeat" },
      {
        at,
        facts: [
          {
            data: {
              deliveryId: "delivery_1",
              parts: [{ kind: "text", text: "Alice asks." }],
              turnId: "turn_0",
            },
            scope: { turnId: "turn_0" },
            type: "delivery.consumed",
          },
        ],
      },
      // A streamed delta reads as no line; the marker keeps the reader's cursor on stored lines.
      { $eve: "position", next: 4 },
    ]);
  });

  it("ends a follow of an earlier eve's session at the tail once nothing owns it", async () => {
    const v26 = { data: {}, meta: { at }, type: "session.started" };
    const followed = async (hasRunnableOwner: boolean) => {
      // A source read without following closes at the tail; a followed one stays open.
      const { follows, session } = sessionOf([v26], { open: hasRunnableOwner });
      const response = await createSessionStreamResponse(
        new Request("https://eve.test/eve/v1/session/session_1/stream"),
        { ...session, hasRunnableOwner: async () => hasRunnableOwner } as Session,
      );
      return { follows, response };
    };

    const ended = await followed(false);
    // Read without following, so the source closes at the tail and readers stop.
    expect(ended.follows.at(-1)).toBe(false);
    expect((await records(ended.response)).at(-1)).toEqual({ $eve: "stream.ended" });

    const live = await followed(true);
    expect(live.follows.at(-1)).toBe(true);
    await live.response.body?.cancel();
  });

  it("serves a fresh stream with no lines yet without a version check failing it", async () => {
    const { session } = sessionOf([]);
    const response = await createSessionStreamResponse(
      new Request("https://eve.test/eve/v1/session/session_1/stream?follow=false"),
      session,
    );
    expect(response.status).toBe(200);
    expect(await records(response)).toEqual([{ $eve: "heartbeat" }]);
  });

  it("opens with a heartbeat, serves the lines, and ends a finished stream with stream.ended", async () => {
    const { session } = sessionOf([line("a"), line("b")]);
    const response = await createSessionStreamResponse(
      new Request("https://eve.test/eve/v1/session/session_1/stream"),
      session,
    );
    expect(await records(response)).toEqual([
      { $eve: "heartbeat" },
      line("a"),
      line("b"),
      { $eve: "stream.ended" },
    ]);
  });

  // On the local world the tail lookup opens every chunk file, so a follow
  // read that does not report the tail must not pay for it.
  it("follows a session without resolving a tail it does not report", async () => {
    const { session, tailLookups } = sessionOf([line("a")]);
    const response = await createSessionStreamResponse(
      new Request("https://eve.test/eve/v1/session/session_1/stream"),
      session,
    );
    expect(response.headers.get(EVE_STREAM_TAIL_INDEX_HEADER)).toBeNull();
    expect(tailLookups()).toBe(0);
    expect(await records(response)).toEqual([
      { $eve: "heartbeat" },
      line("a"),
      { $eve: "stream.ended" },
    ]);
  });

  it("reads from a tail-relative cursor, and bounds a read at the tail it reports", async () => {
    const { session, starts } = sessionOf([line("a"), line("b"), line("c")], { open: true });
    const response = await createSessionStreamResponse(
      new Request(
        "https://eve.test/eve/v1/session/session_1/stream?startIndex=-2&includeTailIndex=1",
      ),
      session,
    );
    expect(response.headers.get(EVE_STREAM_TAIL_INDEX_HEADER)).toBe("2");
    expect(starts).toEqual([0, 1]);
    // The bound ends the response after the tail line, without stream.ended.
    expect(await records(response)).toEqual([{ $eve: "heartbeat" }, line("b"), line("c")]);
  });

  it("sends heartbeats while quiet, and ends its lease so the reader reconnects", async () => {
    vi.useFakeTimers();
    const { session } = sessionOf([line("a")], { open: true });
    const response = await createSessionStreamResponse(
      new Request("https://eve.test/eve/v1/session/session_1/stream"),
      session,
    );
    const body = records(response);
    await vi.advanceTimersByTimeAsync(60_000);
    const received = await body;
    expect(received[0]).toEqual({ $eve: "heartbeat" });
    expect(received[1]).toEqual(line("a"));
    expect(
      received.filter((record) => JSON.stringify(record) === '{"$eve":"heartbeat"}').length,
    ).toBeGreaterThan(1);
    expect(received.at(-1)).toEqual({ $eve: "stream.lease-ended" });
  });
});
