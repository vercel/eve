import { describe, expect, it } from "vitest";

import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";
import { toolCallsOf } from "#evals/tool-calls.js";

function stream(events: readonly SessionEvent[]): SessionStreamEvent[] {
  return events.map((event, line) => ({
    ...event,
    meta: { at: "2026-10-09T00:00:00.000Z", position: { index: 0, line } },
  }));
}

describe("toolCallsOf", () => {
  it("names each call's settlement by its request", () => {
    const calls = toolCallsOf(
      stream([
        {
          data: { cause: { deliveryId: "d_0" }, follows: null, turnId: "turn_0" },
          type: "turn.started",
        },
        {
          data: {
            callId: "call_a",
            capability: { kind: "tool", name: "lookup" },
            input: { q: "a" },
            owner: { runId: "run_0" },
          },
          scope: { runId: "run_0", turnId: "turn_0" },
          type: "call.requested",
        },
        {
          data: {
            callId: "call_b",
            capability: { kind: "tool", name: "lookup" },
            input: { q: "b" },
            owner: { runId: "run_0" },
          },
          scope: { runId: "run_0", turnId: "turn_0" },
          type: "call.requested",
        },
        {
          data: { callId: "call_b", outcome: "completed", output: { found: "b" } },
          scope: { turnId: "turn_0" },
          type: "call.settled",
        },
      ]),
    );

    expect(
      calls.map(({ callId, name, output, status }) => ({ callId, name, output, status })),
    ).toEqual([
      { callId: "call_a", name: "lookup", output: undefined, status: "pending" },
      { callId: "call_b", name: "lookup", output: { found: "b" }, status: "completed" },
    ]);
  });
});
