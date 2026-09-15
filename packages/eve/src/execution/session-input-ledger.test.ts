import { describe, expect, it } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { SessionInputLedger } from "#execution/session-input-ledger.js";

describe("SessionInputLedger", () => {
  it("admits each task delivery once", () => {
    const ledger = new SessionInputLedger();
    const delivery = taskDelivery("task-1:ready:completed");

    expect(ledger.admit(delivery)).toBe(true);
    expect(ledger.admit(delivery)).toBe(false);
  });

  it("always admits conversational deliveries", () => {
    const ledger = new SessionInputLedger();
    const delivery: DeliverHookPayload = { kind: "deliver", payloads: [{ message: "hello" }] };

    expect(ledger.admit(delivery)).toBe(true);
    expect(ledger.admit(delivery)).toBe(true);
  });

  it("rejects deliveries for a cancelled task and its sub-deliveries", () => {
    const ledger = new SessionInputLedger();
    ledger.cancelTask("task-1");

    expect(ledger.isTaskCancelled("task-1")).toBe(true);
    expect(ledger.admit(taskDelivery("task-1"))).toBe(false);
    expect(ledger.admit(taskDelivery("task-1:update:2"))).toBe(false);
    expect(ledger.admit(taskDelivery("task-10:update:2"))).toBe(true);
  });

  it("treats a remembered caller task as already delivered", () => {
    const ledger = new SessionInputLedger();
    ledger.rememberTask("task-1");

    expect(
      ledger.admit({
        caller: {
          callId: "call-1",
          replyTo: { kind: "hook", token: "reply-1" },
          subagentName: "helper",
          taskId: "task-1",
        },
        kind: "deliver",
        payloads: [{ message: "task result" }],
      }),
    ).toBe(false);
  });
});

function taskDelivery(taskDeliveryId: string): DeliverHookPayload {
  return { kind: "deliver", payloads: [{ message: "task update" }], taskDeliveryId };
}
