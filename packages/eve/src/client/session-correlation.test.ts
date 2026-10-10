import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientSession } from "#client/session.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/message.js";
import { encodeTestLine, testTurnFacts as turn } from "#internal/testing/events.js";
import { linesOf } from "#protocol/session-lines.js";

afterEach(() => vi.restoreAllMocks());

function stream(events: readonly SessionEvent[]) {
  return new Response(events.map(encodeTestLine).join(""), {
    headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
  });
}

function session() {
  return new ClientSession(
    { host: "https://eve.test", resolveHeaders: async () => new Headers() },
    { sessionId: "session_1", streamIndex: 0 },
  );
}

function accepted(deliveryId = "new-delivery") {
  return Response.json({ sessionId: "session_1", deliveryId }, { status: 202 });
}

describe("accepted message correlation", () => {
  it.each(["steer", "queue"] as const)(
    "skips completed and in-flight older turns for a %s send from a stale cursor",
    async (turnPolicy) => {
      const current = turn(2, "NEW REPORT", ["new-delivery"]);
      const events = [
        ...turn(0, "OLD REPORT", ["old-delivery"]),
        ...turn(1, "IN FLIGHT REPORT", ["in-flight-delivery"]),
        ...current,
      ];
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(accepted())
        .mockResolvedValueOnce(stream(events));
      const resumed = session();
      const result = await (await resumed.send("new report", { turnPolicy })).result();
      expect(result.message).toBe("NEW REPORT");
      expect(result.events).toHaveLength(current.length);
      expect(resumed.state.streamIndex).toBe(events.length);
    },
  );

  it("accepts a delivery consumed into a turn with another message", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(stream(turn(2, "COALESCED REPORT", ["other", "new-delivery"])));
    expect((await (await session().send("new report")).result()).message).toBe("COALESCED REPORT");
  });

  it("reads past another delivery's settlement to its own", async () => {
    const current = turn(2, "NEW REPORT", ["new-delivery"]);
    const settled = current.length - 1;
    const other: SessionEvent[] = [
      { data: { deliveryId: "control" }, type: "delivery.admitted" },
      { data: { deliveryId: "control", outcome: "applied" }, type: "delivery.settled" },
    ];
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(
        stream([...current.slice(0, settled), ...other, ...current.slice(settled)]),
      );
    const result = await (await session().send("new report")).result();
    expect(result.message).toBe("NEW REPORT");
    expect(result.events).toHaveLength(current.length + other.length);
  });

  it("starts with the whole line that admits the delivery, as a prewarmed session's start", async () => {
    const current = turn(0, "HELLO", ["new-delivery"]);
    const started: SessionEvent = { data: {}, type: "session.started" };
    const first = linesOf([started, current[0]!], "2026-01-01T00:00:00.000Z")
      .map((line) => `${JSON.stringify(line)}\n`)
      .join("");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(
        new Response(first + current.slice(1).map(encodeTestLine).join(""), {
          headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
        }),
      );
    const result = await (await session().send("hello")).result();
    expect(result.events.map((event) => event.type).slice(0, 2)).toEqual([
      "session.started",
      "delivery.admitted",
    ]);
    expect(result.events).toHaveLength(current.length + 1);
  });

  it("fails explicitly when the server does not identify the accepted message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ sessionId: "session_1" }, { status: 202 }),
    );
    await expect(session().send("new report")).rejects.toThrow("delivery id");
  });

  it("does not return a successful old result if the session ends before admitting the delivery", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(
        stream([
          ...turn(0, "OLD REPORT", ["old-delivery"]),
          {
            data: { error: { code: "FAILED", message: "Session failed." }, outcome: "failed" },
            type: "session.ended",
          },
        ]),
      );
    await expect((await session().send("new report")).result()).rejects.toThrow(
      "before it admitted the accepted message",
    );
  });
});
