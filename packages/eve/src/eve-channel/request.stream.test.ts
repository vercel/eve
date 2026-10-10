import { afterEach, describe, expect, it, vi } from "vitest";

import type { Session } from "#channel/session.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";
import { createSessionStreamResponse } from "#eve-channel/request.js";
import { EVE_STREAM_TAIL_INDEX_HEADER } from "#protocol/message.js";

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
      return lines.length - 1;
    },
  };
  return {
    follows,
    session: session as Session,
    starts,
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
    expect(follows).toEqual([false]);
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

  it("reads from a tail-relative cursor, and bounds a read at the tail it reports", async () => {
    const { session, starts } = sessionOf([line("a"), line("b"), line("c")], { open: true });
    const response = await createSessionStreamResponse(
      new Request(
        "https://eve.test/eve/v1/session/session_1/stream?startIndex=-2&includeTailIndex=1",
      ),
      session,
    );
    expect(response.headers.get(EVE_STREAM_TAIL_INDEX_HEADER)).toBe("2");
    expect(starts).toEqual([1]);
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
