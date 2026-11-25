import { describe, expect, it, vi } from "vitest";

import type { InboxItem } from "#execution/durable.js";
import type { TurnStepInput } from "#execution/session/turn-step-types.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { pollSignals } from "#platform/engine.js";

function inboxItem(seq: number, cancel: boolean): InboxItem {
  return {
    id: `item-${seq}`,
    seq,
    body: cancel
      ? { kind: "cancel", reason: "Alice stops the turn." }
      : { kind: "deliver", to: { key: "hook:alice" }, payload: { kind: "unknown" } },
  };
}

describe("pollSignals", () => {
  it("skips every retained inbox item before the turn, and cancels on a new cancel", async () => {
    const items = Array.from({ length: 110 }, (_, index) =>
      inboxItem(index + 1, index + 1 === 105),
    );
    const poll = vi.fn(async (_sessionId: string, afterSeq: number) =>
      items.filter((item) => item.seq > afterSeq).slice(0, 100),
    );
    const input = {
      sessionState: createTestSessionState({ sessionId: "session-alice" }),
      serializedContext: {},
    } as TurnStepInput;

    const polled = pollSignals(poll, "session-alice", input);
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(polled.signals.cancel.aborted).toBe(false);

      for (let seq = 111; seq <= 115; seq += 1) items.push(inboxItem(seq, seq === 115));
      await vi.waitFor(() => expect(polled.signals.cancel.aborted).toBe(true), {
        interval: 10,
        timeout: 2_000,
      });
    } finally {
      polled.stop();
    }
  });
});
