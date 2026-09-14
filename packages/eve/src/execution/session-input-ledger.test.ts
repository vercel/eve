import { describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { SessionInputLedger } from "#execution/session-input-ledger.js";
import { SessionStateCursor } from "#execution/session-state-cursor.js";
import { createTestSessionState } from "#internal/testing/session-state.js";

describe("SessionInputLedger", () => {
  it("deduplicates task deliveries through durable session state", async () => {
    const cursor = createCursor();
    const delivery = taskDelivery("task-1:ready:completed");

    await expect(new SessionInputLedger(cursor).admit(delivery)).resolves.toBe(true);
    await expect(new SessionInputLedger(cursor).admit(delivery)).resolves.toBe(false);
  });

  it("persists task tombstones across ledger instances", async () => {
    const cursor = createCursor();
    await new SessionInputLedger(cursor).cancelTask("task-1");
    const restored = new SessionInputLedger(cursor);

    expect(restored.isTaskCancelled("task-1")).toBe(true);
    await expect(restored.admit(taskDelivery("task-1:update:2"))).resolves.toBe(false);
  });
});

function createCursor(): SessionStateCursor {
  return new SessionStateCursor({
    commandInbox: { claimSessionHook: vi.fn() },
    parentWritable: new WritableStream<Uint8Array>(),
    serializedContext: {},
    sessionState: createTestSessionState({
      continuationToken: "",
      emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_0" },
      hasProxyInputRequests: false,
      sessionId: "session-1",
      version: 1,
    }),
  });
}

function taskDelivery(taskDeliveryId: string): DeliverHookPayload {
  return { kind: "deliver", payloads: [{ message: "task update" }], taskDeliveryId };
}
