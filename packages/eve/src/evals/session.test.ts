import { describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { MessageResponse } from "#client/message-response.js";
import { EvalSessionManager } from "#evals/session.js";
import type { MessageStreamEvent } from "#protocol/message.js";

const events: MessageStreamEvent[] = [
  {
    type: "step.started",
    data: { modelId: "test-model", sequence: 0, stepIndex: 0, turnId: "turn_0" },
    meta: { id: "evt_step", at: "2026-09-10T00:00:00.000Z" },
  },
  {
    type: "message.completed",
    data: {
      finishReason: "stop",
      message: "Recorded output",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    },
    meta: { id: "evt_message", at: "2026-09-10T00:00:00.001Z" },
  },
];
const boundary: MessageStreamEvent = {
  type: "session.waiting",
  data: { continuationToken: "session-1", wait: "next-user-message" },
  meta: { id: "evt_boundary", at: "2026-09-10T00:00:00.002Z" },
};

function setup() {
  const gate = Promise.withResolvers<void>();
  const client = new Client({ host: "https://agent.example.com" });
  vi.spyOn(client.sessions, "create").mockResolvedValue({
    session: client.sessions.attach("session-1"),
    response: new MessageResponse({
      sessionId: "session-1",
      cancelTurn: async () => ({ status: "no_active_turn" }),
      async *createStream() {
        yield* events;
        await gate.promise;
        yield boundary;
      },
    }),
  });
  return { gate, sessions: new EvalSessionManager({ client }) };
}

describe("eval session event retention", () => {
  it("retains observed events when a turn fails before its boundary", async () => {
    const { gate, sessions } = setup();
    const live = await sessions.primary.start("Read the record.");
    await live.waitForEvent("message.completed");
    const error = new Error("Transport timed out");
    gate.reject(error);
    await expect(live.result()).rejects.toBe(error);
    expect(sessions.snapshots()[0]?.events).toEqual(events);
    expect(sessions.primary.events).toEqual([]);
  });

  it("records partial events immediately and does not duplicate them on completion", async () => {
    const { gate, sessions } = setup();
    const live = await sessions.primary.start("Read the record.");
    await live.waitForEvent("message.completed");
    try {
      expect(sessions.snapshots()[0]?.events).toEqual(events);
      expect(sessions.primary.events).toEqual([]);
    } finally {
      gate.resolve();
      await live.result();
    }
    expect(sessions.primary.events).toEqual([...events, boundary]);
    expect(sessions.primary.lastTurn?.events).toEqual([...events, boundary]);
  });
});
