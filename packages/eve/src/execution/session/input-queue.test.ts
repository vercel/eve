import { describe, expect, it } from "vitest";

import type { DeliverHookPayload, SessionAuthContext } from "#channel/types.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import {
  isSteeringDelivery,
  MAX_ADMITTED_OPERATIONS,
  readAdmittedOperations,
  SessionInputQueue,
  withAdmittedOperations,
} from "#execution/session/input-queue.js";

const caller = {
  callId: "call-1",
  replyTo: { kind: "hook" as const, token: "owner-inbox" },
  subagentName: "writer",
};
/** A turn answering call-1 for the session's anonymous principal. */
const CALL_1 = { callerCallId: "call-1", principal: null } as const;

describe("SessionInputQueue.hasSteeringMessage", () => {
  it("finds a callerless or same-caller message that steers", () => {
    const queue = new SessionInputQueue();
    queue.enqueueDelivery({ kind: "deliver", payloads: [{ message: "Add pricing." }] });

    expect(queue.hasSteeringMessage(CALL_1)).toBe(true);
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

    expect(queue.hasSteeringMessage(CALL_1)).toBe(false);
  });
});

describe("the principal check", () => {
  const ALICE: SessionAuthContext = {
    attributes: {},
    authenticator: "slack",
    principalId: "U-alice",
    principalType: "user",
  };
  const BOB: SessionAuthContext = { ...ALICE, principalId: "U-bob" };
  const aliceTurn = { callerCallId: undefined, principal: ALICE };
  const message = (auth: SessionAuthContext | null | undefined, text: string) => {
    const delivery: DeliverHookPayload = { kind: "deliver", payloads: [{ message: text }] };
    return auth === undefined ? delivery : { ...delivery, auth };
  };

  it("lets the turn's own principal steer it, with fresher attributes too", () => {
    const refreshed = { ...ALICE, attributes: { team: "support" } };

    expect(isSteeringDelivery(message(ALICE, "Add the invoice."), aliceTurn)).toBe(true);
    expect(isSteeringDelivery(message(refreshed, "Add the invoice."), aliceTurn)).toBe(true);
    // A delivery without auth keeps the session's principal, as an owner's message does.
    expect(isSteeringDelivery(message(undefined, "Add the invoice."), aliceTurn)).toBe(true);
  });

  it("never lets another principal steer, whatever the turn policy", () => {
    expect(isSteeringDelivery(message(BOB, "Hi, I need help too."), aliceTurn)).toBe(false);
    expect(isSteeringDelivery(message(null, "Hi."), aliceTurn)).toBe(false);
    expect(isSteeringDelivery({ ...message(BOB, "Later."), turnPolicy: "steer" }, aliceTurn)).toBe(
      false,
    );
  });

  it("lets anonymous callers steer each other's turns", () => {
    const anonymousTurn = { callerCallId: undefined, principal: null };

    expect(isSteeringDelivery(message(null, "Also this."), anonymousTurn)).toBe(true);
    expect(isSteeringDelivery(message(ALICE, "Also this."), anonymousTurn)).toBe(false);
  });

  it("takes only the turn's own principal's messages and keeps the rest queued in order", () => {
    const queue = new SessionInputQueue();
    queue.enqueueDelivery(message(BOB, "Bob: can you check my order?"));
    queue.enqueueDelivery(message(ALICE, "Alice: include the refund."));
    queue.enqueueDelivery(message(BOB, "Bob: order 42."));

    expect(queue.hasSteeringMessage(aliceTurn)).toBe(true);
    expect(queue.takeSteering(new Set([0, 1, 2]), aliceTurn)?.delivery).toEqual(
      message(ALICE, "Alice: include the refund."),
    );
    expect(queue.hasSteeringMessage(aliceTurn)).toBe(false);

    // Once Alice's turn ends, Bob's messages start one turn of his own.
    expect(queue.takeNext()).toMatchObject({
      delivery: {
        auth: BOB,
        payloads: [{ message: "Bob: can you check my order?" }, { message: "Bob: order 42." }],
      },
      kind: "turn",
    });
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
    queue.takeSteering(new Set([0]), CALL_1);
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

    const steering = queue.takeSteering(new Set([0, 1]), CALL_1);
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
    expect(queue.hasSteeringMessage(CALL_1)).toBe(true);
    expect(queue.takeSteerCount("call-1")).toBe(0);
    // A resent copy of the dropped message stays dropped.
    expect(queue.enqueueDelivery(steer("turn-1:call-2"))).toBeUndefined();
  });
});

describe("follow-up operation ids", () => {
  const ALICE = {
    attributes: {},
    authenticator: "slack",
    principalId: "U-alice",
    principalType: "user",
  } as const;
  const BOB = { ...ALICE, principalId: "U-bob" } as const;
  const followUp = (auth: SessionAuthContext, operationId: string) => ({
    auth,
    kind: "deliver" as const,
    operationId,
    payloads: [{ message: "Also check the invoice." }],
  });

  it("admits the same operation id once per principal, so two clients never drop each other", () => {
    const queue = new SessionInputQueue();

    expect(queue.enqueueDelivery(followUp(ALICE, "retry-1"))).toBeDefined();
    expect(queue.enqueueDelivery(followUp(BOB, "retry-1"))).toBeDefined();
    expect(queue.enqueueDelivery(followUp(ALICE, "retry-1"))).toBeUndefined();
    expect(queue.pendingCount).toBe(2);
  });

  it("keeps dropping resends after a handoff, from the operations its predecessor admitted", () => {
    const predecessor = new SessionInputQueue();
    predecessor.enqueueDelivery(followUp(ALICE, "retry-1"));
    const session = {
      agent: { dynamicModel: true as const, system: "", tools: [] },
      compaction: { recentWindowSize: 5, threshold: 10_000 },
      continuationToken: "token",
      history: [],
      sessionId: "session",
    };
    const handedOff = withAdmittedOperations(
      createDurableSessionState({ session }),
      predecessor.admittedOperations(),
    );

    const successor = new SessionInputQueue({
      admittedOperations: readAdmittedOperations(readDurableSession(handedOff).state),
    });

    expect(successor.enqueueDelivery(followUp(ALICE, "retry-1"))).toBeUndefined();
    expect(successor.enqueueDelivery(followUp(ALICE, "retry-2"))).toBeDefined();
  });

  it("remembers a bounded number of operations, oldest dropped first", () => {
    const queue = new SessionInputQueue();
    for (let index = 0; index <= MAX_ADMITTED_OPERATIONS; index += 1) {
      queue.enqueueDelivery(followUp(ALICE, `op-${String(index)}`));
    }

    expect(queue.admittedOperations()).toHaveLength(MAX_ADMITTED_OPERATIONS);
    expect(queue.enqueueDelivery(followUp(ALICE, "op-0"))).toBeDefined();
    expect(
      queue.enqueueDelivery(followUp(ALICE, `op-${String(MAX_ADMITTED_OPERATIONS)}`)),
    ).toBeUndefined();
  });
});
