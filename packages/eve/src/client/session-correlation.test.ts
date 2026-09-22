import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientSession } from "#client/session.js";
import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/message.js";

afterEach(() => vi.restoreAllMocks());

function turn(sequence: number, message: string, deliveryIds: string[]) {
  const data = { sequence, stepIndex: 0, turnId: `turn_${sequence}` };
  const meta = { at: new Date().toISOString(), id: `event_${sequence}`, deliveryIds };
  return [
    { type: "turn.started", data, meta },
    { type: "message.completed", data: { ...data, message, finishReason: "stop" }, meta },
    { type: "turn.completed", data, meta },
    { type: "session.waiting", meta },
  ];
}

function stream(events: readonly unknown[]) {
  return new Response(events.map((event) => JSON.stringify(event)).join("\n") + "\n", {
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
      const events = [
        ...turn(0, "OLD REPORT", ["old-delivery"]),
        ...turn(1, "IN FLIGHT REPORT", ["in-flight-delivery"]),
        ...turn(2, "NEW REPORT", ["new-delivery"]),
      ];
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(accepted())
        .mockResolvedValueOnce(stream(events));
      const resumed = session();
      const result = await (await resumed.send("new report", { turnPolicy })).result();
      expect(result.message).toBe("NEW REPORT");
      expect(result.events).toHaveLength(4);
      expect(resumed.state.streamIndex).toBe(events.length);
    },
  );

  it("accepts a delivery coalesced with another message", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(stream(turn(2, "COALESCED REPORT", ["other", "new-delivery"])));
    expect((await (await session().send("new report")).result()).message).toBe("COALESCED REPORT");
  });

  it("ignores an older delivery replayed after the accepted turn starts", async () => {
    const current = turn(2, "NEW REPORT", ["new-delivery"]);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(
        stream([
          current[0],
          ...turn(1, "REPLAYED OLD REPORT", ["old-delivery"]),
          ...current.slice(1),
        ]),
      );
    const result = await (await session().send("new report")).result();
    expect(result.message).toBe("NEW REPORT");
    expect(result.events).toHaveLength(4);
  });

  it("fails explicitly when the server does not identify the accepted message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ sessionId: "session_1" }, { status: 202 }),
    );
    await expect(session().send("new report")).rejects.toThrow("delivery id");
  });

  it("does not return a successful old result if the session terminates before delivery", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(
        stream([
          ...turn(0, "OLD REPORT", ["old-delivery"]),
          { type: "session.failed", data: { code: "FAILED", message: "Session failed." } },
        ]),
      );
    await expect((await session().send("new report")).result()).rejects.toThrow(
      "before the accepted message",
    );
  });
});
