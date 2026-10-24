import { interaction, turns } from "#protocol/session-projection/public-view.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { EvalSessionManager } from "#evals/session-manager.js";
import { encodeTestLine, testTurnFacts } from "#internal/testing/events.js";
import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/session-http.js";
import type { SessionEvent } from "#protocol/session-event.js";

afterEach(() => vi.restoreAllMocks());

const turnId = "turn_0";
const runId = "run_0";

/** A turn that calls `lookup` twice: the first call fails, the second completes. */
function lookupTurn(): SessionEvent[] {
  const [admitted, started, consumed, requested, ...rest] = testTurnFacts(0, "Done.", ["d_1"]);
  const scope = { runId, turnId };
  const call = (callId: string, query: string): SessionEvent => ({
    data: {
      callId,
      capability: { kind: "tool", name: "lookup" },
      input: { query },
      owner: { runId },
    },
    scope,
    type: "call.requested",
  });
  return [
    admitted!,
    started!,
    consumed!,
    requested!,
    call("call_a", "first"),
    call("call_b", "second"),
    {
      data: { callId: "call_a", error: { code: "E", message: "no" }, outcome: "failed" },
      scope,
      type: "call.settled",
    },
    {
      data: { callId: "call_b", outcome: "completed", output: { hits: 2 } },
      scope,
      type: "call.settled",
    },
    ...rest,
  ];
}

function watch(events: readonly SessionEvent[]) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(events.map(encodeTestLine).join(""), {
      headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
    }),
  );
  const manager = new EvalSessionManager({ client: new Client({ baseUrl: "https://eve.test" }) });
  return manager.attach("session_1", { startIndex: 0 }).watch();
}

describe("EveEvalLiveTurn", () => {
  it("keeps a queued delivery open past another turn's pause and settlement", async () => {
    const old = testTurnFacts(0, "Earlier.", ["old"]);
    const own = testTurnFacts(1, "Queued reply.", ["d_1"]);
    const events: SessionEvent[] = [
      ...old.slice(0, 3),
      own[0]!,
      {
        type: "turn.paused",
        data: { turnId: "turn_0", awaiting: [] },
        scope: { turnId: "turn_0" },
      },
      ...old.filter((event) => event.type === "turn.settled"),
      ...own.slice(1),
    ];
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ ok: true, sessionId: "session_1", deliveryId: "d_1" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        new Response(events.map(encodeTestLine).join(""), {
          headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
        }),
      );
    const manager = new EvalSessionManager({ client: new Client({ baseUrl: "https://eve.test" }) });
    const turn = await manager.attach("session_1").send("Queued message.");
    expect(turn.reply).toBe("Queued reply.");
    expect(turn.status).toBe("completed");
    expect(turn.outcome).toBe("handled");
  });

  it("keeps earlier and intervening questions when an answer delivery settles", async () => {
    const question = (interactionId: string): SessionEvent => ({
      type: "interaction.opened",
      data: {
        interactionId,
        request: { kind: "question", prompt: interactionId, allowFreeform: true },
        subject: { turnId },
      },
    });
    const paused: SessionEvent = {
      type: "turn.paused",
      data: { turnId, awaiting: [{ interactionId: "first" }, { interactionId: "second" }] },
    };
    const response = (events: readonly SessionEvent[]) =>
      new Response(events.map(encodeTestLine).join(""), {
        headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
      });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response([
          ...testTurnFacts(0, "", ["initial"]).slice(0, 3),
          question("first"),
          question("second"),
          paused,
        ]),
      )
      .mockResolvedValueOnce(
        Response.json({ ok: true, sessionId: "session_1", deliveryId: "answer" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        response([
          question("third"),
          { type: "delivery.admitted", data: { deliveryId: "answer" } },
          { type: "delivery.consumed", data: { deliveryId: "answer", parts: [], turnId } },
          {
            type: "response.submitted",
            data: {
              deliveryId: "answer",
              interactionId: "first",
              responseId: "r_1",
              value: { text: "Alice's answer" },
            },
          },
          { type: "response.settled", data: { responseId: "r_1", outcome: "applied" } },
          {
            type: "interaction.settled",
            data: { interactionId: "first", outcome: "accepted", cause: { responseId: "r_1" } },
          },
          {
            type: "delivery.settled",
            data: { deliveryId: "answer", outcome: "awaiting-input", turnId },
          },
        ]),
      );
    const manager = new EvalSessionManager({ client: new Client({ baseUrl: "https://eve.test" }) });
    const session = manager.attach("session_1");
    await session.nextTurn();
    expect(session.pendingInteractions.map((row) => row.interactionId)).toEqual([
      "first",
      "second",
    ]);
    const answered = await session.respond([{ interactionId: "first", text: "Alice's answer" }]);
    expect(answered.status).toBe("awaiting-input");
    expect(session.pendingInteractions.map((row) => row.interactionId)).toEqual([
      "second",
      "third",
    ]);
    expect(answered.interactions.map((row) => row.interactionId)).toEqual(["second", "third"]);
    expect(answered.events.some((event) => event.type === "interaction.opened")).toBe(false);
    expect(interaction(session.view, "third")?.status).toBe("open");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("attaches without I/O and advances the same session cursor across nextTurn and watch", async () => {
    const first = testTurnFacts(0, "First.", ["first"]);
    const second = testTurnFacts(1, "Second.", ["second"]);
    const response = (events: readonly SessionEvent[]) =>
      new Response(events.map(encodeTestLine).join(""), {
        headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
      });
    const afterTurn = first.findIndex((event) => event.type === "turn.settled") + 1;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response([...first.slice(afterTurn), ...second]));
    const manager = new EvalSessionManager({ client: new Client({ baseUrl: "https://eve.test" }) });
    const session = manager.attach("session_1");
    expect(session.id).toBe("session_1");
    expect(fetch).not.toHaveBeenCalled();
    expect((await session.nextTurn()).reply).toBe("First.");
    const cursor = session.state.streamIndex;
    expect(cursor).toBeGreaterThan(0);
    expect((await session.watch().result()).reply).toBe("Second.");
    expect(String(fetch.mock.calls[1]?.[0])).toContain(`startIndex=${cursor}`);
    expect(session.state.streamIndex).toBeGreaterThan(cursor);
    expect(turns(session.view).map(({ turnId }) => turnId)).toEqual(["turn_0", "turn_1"]);
  });

  it("waits for a settled call to a tool, by default with any outcome", async () => {
    const live = watch(lookupTurn());

    await expect(live.waitForToolCall("lookup")).resolves.toMatchObject({
      callId: "call_a",
      status: "failed",
    });
    await live.result();
  });

  it("waits for the call that matches its options", async () => {
    const live = watch(lookupTurn());

    await expect(
      live.waitForToolCall("lookup", { input: { query: "second" }, status: "completed" }),
    ).resolves.toMatchObject({ callId: "call_b", output: { hits: 2 } });
    await live.result();
  });

  it("matches a fact's scope as well as its data", async () => {
    const live = watch(lookupTurn());

    await expect(
      live.waitForEvent("call.requested", { scope: { runId }, data: { callId: "call_b" } }),
    ).resolves.toMatchObject({ data: { callId: "call_b" } });
    const turn = await live.result();
    turn.event("call.settled", { count: 2, scope: { turnId } });
  });

  it("rejects a wait the turn ends before", async () => {
    const live = watch(lookupTurn());

    await expect(live.waitForToolCall("missing")).rejects.toThrow(/before the expected event/);
    await live.result();
  });
});
