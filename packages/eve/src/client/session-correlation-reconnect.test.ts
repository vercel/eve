import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientSession } from "#client/session.js";
import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/message.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { encodeTestLine, testTurnFacts } from "#internal/testing/events.js";

afterEach(() => vi.restoreAllMocks());

function turn(sequence: number, message: string, deliveryId: string) {
  return testTurnFacts(sequence, message, [deliveryId]);
}
function stream(events: readonly SessionEvent[]) {
  return new Response(events.map(encodeTestLine).join(""), {
    headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
  });
}
function accepted(deliveryId = "new") {
  return Response.json({ sessionId: "session_1", deliveryId }, { status: 202 });
}
function session(
  resolveHeaders = async (_headers?: Readonly<Record<string, string>>) => new Headers(),
) {
  return new ClientSession(
    { host: "https://eve.test", resolveHeaders },
    { sessionId: "session_1", streamIndex: 0 },
  );
}

describe("delivery correlation across reconnects and concurrent sends", () => {
  it("reconnects past only old history with the same headers and advances all consumed events", async () => {
    const controller = new AbortController();
    const resolveHeaders = vi.fn(
      async (headers?: Readonly<Record<string, string>>) => new Headers(headers),
    );
    const old = turn(0, "OLD", "old");
    const current = turn(1, "NEW", "new");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(stream(old))
      .mockResolvedValueOnce(stream(current));
    const resumed = session(resolveHeaders);
    const result = await (
      await resumed.send("new", {
        headers: { authorization: "Bearer fixture" },
        signal: controller.signal,
        streamReconnectPolicy: {},
      })
    ).result();
    expect(result.message).toBe("NEW");
    expect(resumed.state.streamIndex).toBe(old.length + current.length);
    expect(String(fetch.mock.calls[2]?.[0])).toContain(`startIndex=${old.length}`);
    expect(resolveHeaders).toHaveBeenCalledTimes(3);
    expect(
      resolveHeaders.mock.calls.every(([headers]) => headers?.authorization === "Bearer fixture"),
    ).toBe(true);
  });

  it("does not report success when a bounded reconnect policy ends before the accepted delivery", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(stream(turn(0, "OLD", "old")));
    const response = await session().send("new", { streamReconnectPolicy: { reconnect: false } });
    await expect(response.result()).rejects.toThrow();
  });

  it("does not ignore a session-wide failure after observing the accepted turn", async () => {
    const current = turn(1, "PARTIAL", "new");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(
        stream([
          ...current.slice(0, 3),
          {
            data: { error: { code: "FAILED", message: "Session ended" }, outcome: "failed" },
            type: "session.ended",
          },
        ]),
      );
    const response = await session().send("new", { streamReconnectPolicy: { reconnect: false } });
    const result = await response.result();
    expect(result.status).toBe("failed");
    expect(result.events.at(-1)?.type).toBe("session.ended");
  });

  it("does not regress the cursor when concurrent sends are consumed out of order", async () => {
    const events = [...turn(1, "FIRST", "first"), ...turn(2, "SECOND", "second")];
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(accepted("first"))
      .mockResolvedValueOnce(accepted("second"))
      .mockResolvedValueOnce(stream(events))
      .mockResolvedValueOnce(stream(events));
    const resumed = session();
    const first = await resumed.send("first");
    const second = await resumed.send("second");
    expect((await second.result()).message).toBe("SECOND");
    expect((await first.result()).message).toBe("FIRST");
    expect(resumed.state.streamIndex).toBe(events.length);
  });

  it("preserves the saved cursor when posting the new request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("network failed"));
    const resumed = session();
    await expect(resumed.send("new")).rejects.toThrow("network failed");
    expect(resumed.state.streamIndex).toBe(0);
  });
});
