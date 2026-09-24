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

describe("an owner's steering messages", () => {
  const steer = (key: string, message = "Mention the price.") => ({
    caller,
    kind: "deliver" as const,
    payloads: [{ message }],
    operationId: key,
  });

  it("admits each key once, so a resent message is dropped", () => {
    const queue = new SessionInputQueue();

    expect(queue.enqueueDelivery(steer("turn-1:call-2"))).toBeDefined();
    expect(queue.enqueueDelivery(steer("turn-1:call-2"))).toBeUndefined();
    expect(queue.pendingCount).toBe(1);
    expect(queue.takeSteerCount("call-1")).toBe(1);
  });

  it("counts a message that arrives after the answer toward the call's next turn", () => {
    // The writer answered call-1 and reported the one message it had.
    const queue = new SessionInputQueue();
    queue.enqueueDelivery(steer("turn-1:call-2"));
    queue.takeSteering(new Set([0]), "call-1");
    expect(queue.takeSteerCount("call-1")).toBe(1);

    // A message sent just before the owner applied that answer arrives now:
    // it starts a new turn for the same call and counts toward that answer.
    queue.enqueueDelivery(steer("turn-1:call-3", "Mention the date."));
    const next = queue.takeNext();
    expect(next).toMatchObject({
      delivery: { caller, operationId: "turn-1:call-3" },
      kind: "turn",
    });
    expect(queue.takeSteerCount("call-1")).toBe(1);
    expect(queue.takeSteerCount("call-1")).toBe(0);
  });

  it("coalesces steering messages for the same call", () => {
    const queue = new SessionInputQueue();
    queue.enqueueDelivery(steer("turn-1:call-2"));
    queue.enqueueDelivery(steer("turn-1:call-3", "Mention the date."));

    const steering = queue.takeSteering(new Set([0, 1]), "call-1");
    expect(steering?.delivery).toMatchObject({
      caller,
      payloads: [{ message: "Mention the price." }, { message: "Mention the date." }],
    });
  });

  it("admits an owner's new call once without counting it as a steering message", () => {
    const queue = new SessionInputQueue();
    const next = {
      caller: { ...caller, callId: "call-4" },
      kind: "deliver" as const,
      operationId: "turn-2:call-4",
      payloads: [{ message: "Now draft the summary." }],
      turnPolicy: "queue" as const,
    };

    expect(queue.enqueueDelivery(next)).toBeDefined();
    expect(queue.enqueueDelivery(next)).toBeUndefined();
    expect(queue.pendingCount).toBe(1);
    expect(queue.takeSteerCount("call-4")).toBe(0);
  });

  it("drops a cancelled call's waiting messages so they start no work", () => {
    const queue = new SessionInputQueue();
    queue.enqueueDelivery(steer("turn-1:call-2"));
    queue.enqueueDelivery({ kind: "deliver", payloads: [{ message: "Unrelated." }] });

    queue.discardSteering("call-1");

    expect(queue.pendingCount).toBe(1);
    expect(queue.hasSteeringMessage("call-1")).toBe(true);
    expect(queue.takeSteerCount("call-1")).toBe(0);
    // A resent copy of the dropped message stays dropped.
    expect(queue.enqueueDelivery(steer("turn-1:call-2"))).toBeUndefined();
  });
});
