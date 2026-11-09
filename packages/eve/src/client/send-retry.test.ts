import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { getDeliveryReceipt } from "#client/delivery.js";
import { ClientSession } from "#client/session.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function session(resolveHeaders: () => Promise<Headers> = async () => new Headers()) {
  return new ClientSession(
    { baseUrl: "https://eve.test", resolveHeaders },
    { sessionId: "session_1", streamIndex: 0 },
  );
}

function accepted() {
  return Response.json({ sessionId: "session_1", deliveryId: "delivery_1" }, { status: 202 });
}

function conflict(code: string) {
  return Response.json({ code, error: "The request conflicts.", ok: false }, { status: 409 });
}

describe("session send readiness retries", () => {
  it("backs off on session_not_ready and reports the wait apart from the accepted send", async () => {
    let headerResolution = 0;
    const observedHeaders: string[] = [];
    const observedPaths: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      observedPaths.push(new URL(String(request)).pathname);
      observedHeaders.push(new Headers(init?.headers).get("x-attempt") ?? "");
      return fetchMock.mock.calls.length <= 4 ? conflict("session_not_ready") : accepted();
    });
    const handle = session(
      async () => new Headers({ "x-attempt": String((headerResolution += 1)) }),
    );

    vi.useFakeTimers();
    const startedAt = Date.now();
    const sent = handle.send("ready soon");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const [delayMs, calls] of [
      [250, 2],
      [500, 3],
      [1_000, 4],
      [2_000, 5],
    ] as const) {
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(fetchMock).toHaveBeenCalledTimes(calls - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    }
    const delivery = await sent;

    expect(delivery.deliveryId).toBe("delivery_1");
    expect(getDeliveryReceipt(delivery)).toEqual({
      deliveryId: "delivery_1",
      startedAt,
      notReadyMs: 3_750,
      acceptedAt: startedAt + 3_750,
    });
    // Each attempt resolves fresh headers so rotated credentials apply to retries.
    expect(observedHeaders).toEqual(["1", "2", "3", "4", "5"]);
    expect(new Set(observedPaths)).toEqual(new Set(["/eve/v1/session/session_1"]));
  });

  it("surfaces the retryable conflict once the readiness deadline passes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => conflict("session_not_ready"));

    vi.useFakeTimers();
    const sent = session()
      .send("too late")
      .catch((cause: unknown) => cause);
    await vi.runAllTimersAsync();
    const error = await sent;

    expect(SessionNotActiveError.is(error)).toBe(true);
    expect(error).toMatchObject({ retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(14);
  });

  it.each([
    ["send session_not_active", "session_not_active", (s: ClientSession) => s.send("hi")],
    ["send another_conflict", "another_conflict", (s: ClientSession) => s.send("hi")],
    [
      "respond session_not_ready",
      "session_not_ready",
      (s: ClientSession) => s.respond([{ interactionId: "i_1", text: "Approved." }]),
    ],
  ])("does not retry %s", async (_name, code, act) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(conflict(code));

    await expect(act(session())).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
