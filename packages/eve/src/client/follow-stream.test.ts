import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientSessionStrandedError } from "#client/client-error.js";
import { followStreamLines } from "#client/open-stream.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/session-http.js";

afterEach(() => vi.restoreAllMocks());

const at = "2026-10-09T00:00:00.000Z";
const line = (deliveryId: string) => ({
  at,
  facts: [{ data: { deliveryId }, type: "delivery.admitted" }],
});

/** Serves each request the next body, recording the `startIndex` it asked for. */
function serve(bodies: readonly (readonly unknown[])[], tailIndex?: number) {
  const starts: number[] = [];
  let next = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
    const url = new URL(String(request instanceof Request ? request.url : request));
    starts.push(Number(url.searchParams.get("startIndex") ?? "0"));
    const records = bodies[Math.min(next, bodies.length - 1)] ?? [];
    next += 1;
    const headers: Record<string, string> = {
      [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
    };
    if (tailIndex !== undefined) headers[EVE_STREAM_TAIL_INDEX_HEADER] = String(tailIndex);
    return new Response(records.map((record) => `${JSON.stringify(record)}\n`).join(""), {
      headers,
    });
  });
  return starts;
}

async function read(input: { readonly startIndex: number; readonly follow?: boolean }) {
  const positions: number[] = [];
  for await (const { position } of followStreamLines({
    follow: input.follow,
    baseUrl: "https://eve.test",
    path: "/eve/v1/session/s/stream",
    resolveHeaders: async () => new Headers(),
    startIndex: input.startIndex,
  })) {
    positions.push(position);
  }
  return positions;
}

describe("followStreamLines", () => {
  it("stops reconnecting when a stranded stream returns an actionable conflict", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          code: "session_stranded",
          eveVersion: "0.0.1",
          error: "Reset this session to continue.",
        },
        { status: 409 },
      ),
    );
    await expect(read({ startIndex: 0 })).rejects.toThrow(ClientSessionStrandedError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("releases the connection when the stream version is unsupported", async () => {
    let cancelled = false;
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { headers: { [EVE_STREAM_VERSION_HEADER]: "26" } });
    });
    await expect(read({ startIndex: 0 })).rejects.toThrow(
      "Unsupported message stream version: 26.",
    );
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it("asks a bounded read not to follow", async () => {
    const urls: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      urls.push(new URL(String(request instanceof Request ? request.url : request)));
      return new Response(`${JSON.stringify(line("a"))}\n`, {
        headers: {
          [EVE_STREAM_TAIL_INDEX_HEADER]: "0",
          [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
        },
      });
    });
    await expect(read({ follow: false, startIndex: 0 })).resolves.toEqual([0]);
    expect(urls[0]?.searchParams.get("follow")).toBe("false");
  });

  it("stops for good on stream.ended", async () => {
    const starts = serve([[line("a"), line("b"), { $eve: "stream.ended" }]]);
    await expect(read({ startIndex: 0 })).resolves.toEqual([0, 1]);
    expect(starts).toEqual([0]);
  });

  it("reconnects at once from its cursor when a lease ends", async () => {
    const starts = serve([
      [{ $eve: "heartbeat" }, line("a"), { $eve: "stream.lease-ended" }],
      [line("b"), { $eve: "stream.ended" }],
    ]);
    await expect(read({ startIndex: 0 })).resolves.toEqual([0, 1]);
    expect(starts).toEqual([0, 1]);
  });

  it("jumps its cursor forward at a position marker", async () => {
    const starts = serve([
      [line("a"), { $eve: "position", next: 5 }, line("f"), { $eve: "stream.ended" }],
    ]);
    await expect(read({ startIndex: 0 })).resolves.toEqual([0, 5]);
    expect(starts).toEqual([0]);
  });

  it("skips a malformed position marker without moving its cursor", async () => {
    const starts = serve([
      [
        line("a"),
        { $eve: "position" },
        { $eve: "position", next: "5" },
        { $eve: "position", next: 2.5 },
        line("b"),
        { $eve: "stream.ended" },
      ],
    ]);
    await expect(read({ startIndex: 0 })).resolves.toEqual([0, 1]);
    expect(starts).toEqual([0]);
  });

  it("stops at once when the session was started on an earlier eve", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json(
          { code: "session_version_unsupported", error: "Start a new session.", ok: false },
          { status: 409 },
        ),
      );
    await expect(read({ startIndex: 0 })).rejects.toMatchObject({
      code: "session_version_unsupported",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects legacy records even when an older proxy advertises the current stream version", async () => {
    const starts = serve([
      [
        { type: "message.received", data: {}, meta: { at: "2026-10-10T00:00:00.000Z", id: "old" } },
        { $eve: "stream.ended" },
      ],
    ]);
    await expect(read({ startIndex: 0 })).rejects.toMatchObject({
      code: "session_version_unsupported",
    });
    expect(starts).toEqual([0]);
  });

  it("resolves a tail-relative cursor from the tail the server reports", async () => {
    serve([[line("c"), { $eve: "stream.ended" }]], 2);
    await expect(read({ startIndex: -1 })).resolves.toEqual([2]);
  });

  it("ends a bounded read once it passes the tail it opened at", async () => {
    serve([[line("a"), line("b"), line("c")]], 1);
    await expect(read({ follow: false, startIndex: 0 })).resolves.toEqual([0, 1]);
  });
});
