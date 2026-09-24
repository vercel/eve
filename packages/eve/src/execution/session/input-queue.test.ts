import { describe, expect, it } from "vitest";

import { SessionInputQueue } from "#execution/session/input-queue.js";

const caller = {
  callId: "call-1",
  replyTo: { kind: "hook" as const, token: "owner-inbox" },
  subagentName: "writer",
};

describe("SessionInputQueue.hasSteeringMessage", () => {
  it("finds a callerless or same-caller message that steers", () => {
    const queue = new SessionInputQueue();
    queue.enqueueDelivery({ kind: "deliver", payloads: [{ message: "Add pricing." }] });

    expect(queue.hasSteeringMessage("call-1")).toBe(true);
  });

  it("ignores queued messages, answers, and another caller's message", () => {
    const queue = new SessionInputQueue();
    queue.enqueueDelivery({
      kind: "deliver",
      payloads: [{ message: "Later." }],
      turnPolicy: "queue",
    });
    queue.enqueueDelivery({
      kind: "deliver",
      payloads: [{ inputResponses: [{ optionId: "yes", requestId: "request-1" }] }],
    });
    queue.enqueueDelivery({
      caller: { ...caller, callId: "call-2" },
      kind: "deliver",
      payloads: [{ message: "Next task." }],
    });

    expect(queue.hasSteeringMessage("call-1")).toBe(false);
  });
});
