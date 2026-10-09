import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { EvalSessionManager } from "#evals/session-manager.js";
import { encodeTestLine, testTurnFacts } from "#internal/testing/events.js";
import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/message.js";
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
  const manager = new EvalSessionManager({ client: new Client({ host: "https://eve.test" }) });
  return manager.watchTurn("session_1", { startIndex: 0 });
}

describe("EveEvalLiveTurn", () => {
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
