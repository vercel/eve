import { afterEach, describe, expect, it, vi } from "vitest";

import { followStreamLines } from "#client/open-stream.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";

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
    host: "https://eve.test",
    path: "/eve/v1/session/s/stream",
    resolveHeaders: async () => new Headers(),
    startIndex: input.startIndex,
  })) {
    positions.push(position);
  }
  return positions;
}

describe("followStreamLines", () => {
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

  it("resolves a tail-relative cursor from the tail the server reports", async () => {
    serve([[line("c"), { $eve: "stream.ended" }]], 2);
    await expect(read({ startIndex: -1 })).resolves.toEqual([2]);
  });

  it("ends a bounded read once it passes the tail it opened at", async () => {
    serve([[line("a"), line("b"), line("c")]], 1);
    await expect(read({ follow: false, startIndex: 0 })).resolves.toEqual([0, 1]);
  });
});
