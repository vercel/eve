import { describe, expect, it } from "vitest";

import { SessionInputQueue } from "#execution/session/input-queue.js";
import { principalOf } from "#execution/session/principal.js";

function signInCallback(attemptId: string) {
  return {
    authorizationCallback: {
      attemptId,
      callback: { method: "GET" as const, params: { code: "oauth-code" } },
      connectionName: attemptId.split("-")[0]!,
    },
  };
}

describe("SessionInputQueue", () => {
  it("admits a keyed delivery once, even after its turn has consumed it", () => {
    const queue = new SessionInputQueue([]);
    const delivery = {
      idempotencyKey: "provider-1",
      kind: "deliver" as const,
      payloads: [{ message: "Alice asks for a report." }],
    };
    expect(queue.enqueueDelivery(delivery)).toBeDefined();
    expect(queue.takeNext()?.kind).toBe("turn");
    expect(queue.enqueueDelivery(delivery)).toBeUndefined();
    expect(queue.takeNext()).toBeUndefined();
  });

  it("retains the most recent 1024 distinct keys without refreshing duplicates", () => {
    const queue = new SessionInputQueue([]);
    const delivery = (idempotencyKey: string) => ({
      idempotencyKey,
      kind: "deliver" as const,
      payloads: [{ message: idempotencyKey }],
    });
    for (let index = 0; index < 1024; index++) {
      queue.enqueueDelivery(delivery(String(index)));
      queue.takeNext();
    }
    expect(queue.enqueueDelivery(delivery("0"))).toBeUndefined();
    queue.enqueueDelivery(delivery("1024"));
    queue.takeNext();
    expect(queue.enqueueDelivery(delivery("1"))).toBeUndefined();
    expect(queue.enqueueDelivery(delivery("0"))).toBeDefined();
  });

  it("keeps unkeyed deliveries independent and scopes keys to each session", () => {
    const delivery = {
      kind: "deliver" as const,
      payloads: [{ message: "Alice asks for a report." }],
    };
    const first = new SessionInputQueue([]);
    expect(first.enqueueDelivery(delivery)).toBeDefined();
    expect(first.enqueueDelivery(delivery)).toBeDefined();
    expect(first.enqueueDelivery({ ...delivery, idempotencyKey: "shared" })).toBeDefined();
    expect(
      new SessionInputQueue([]).enqueueDelivery({ ...delivery, idempotencyKey: "shared" }),
    ).toBeDefined();
  });

  it("resumes a turn holding several sign-ins only once every one has called back", () => {
    const queue = new SessionInputQueue([]);
    const held = new Set(["linear-1", "notion-1"]);

    queue.enqueueAuthorization([signInCallback("linear-1")]);
    expect(queue.takeAuthorizations(held)).toBeUndefined();

    queue.enqueueAuthorization([signInCallback("notion-1")]);
    expect(queue.takeAuthorizations(held)).toEqual([
      signInCallback("linear-1"),
      signInCallback("notion-1"),
    ]);
    expect(queue.takeAuthorizations(held)).toBeUndefined();
  });

  it("lets a queued message steer a held turn only when it arrived after the hold", () => {
    const queue = new SessionInputQueue([]);
    const turn = { callerCallId: undefined, principal: "user:test:alice" };
    const send = (message: string) =>
      queue.enqueueDelivery({
        kind: "deliver",
        payloads: [{ message }],
        turnPolicy: "queue",
      })!.sequence;

    const before = send("approve");
    const heldSince = queue.nextAdmission;
    const after = send("never mind");
    const admitted = new Set([before, after]);

    expect(queue.takeSteering(admitted, turn)).toBeUndefined();
    expect(queue.takeSteering(admitted, turn, { heldSince })?.sequences).toEqual([after]);
    expect(queue.takeNext()).toMatchObject({ sequences: [before] });
  });

  // #4923: a parked turn stays its principal's; another person's input waits.
  it("takes only what may join a parked open turn", () => {
    const alice = {
      attributes: {},
      authenticator: "test",
      principalId: "alice",
      principalType: "user",
    };
    const bob = { ...alice, principalId: "bob" };
    const openTurn = { callerCallId: undefined, principal: principalOf(alice) };
    const queue = new SessionInputQueue([]);
    const answer = { inputResponses: [{ optionId: "stop", requestId: "limit-1" }] };
    const bobText = queue.enqueueDelivery({
      auth: bob,
      kind: "deliver",
      payloads: [{ message: "bob here" }],
    })!.sequence;
    const bobMixed = queue.enqueueDelivery({
      auth: bob,
      kind: "deliver",
      payloads: [answer, { message: "and stop" }],
    })!.sequence;
    const aliceText = queue.enqueueDelivery({
      auth: alice,
      kind: "deliver",
      payloads: [{ message: "keep going" }],
    })!.sequence;

    expect(queue.takeNext({ openTurn })).toEqual({
      delivery: { auth: bob, kind: "deliver", payloads: [answer] },
      handoffEligible: false,
      kind: "turn",
      sequences: [bobMixed],
    });
    expect(queue.takeNext({ openTurn })).toMatchObject({
      delivery: { auth: alice, payloads: [{ message: "keep going" }] },
      sequences: [aliceText],
    });
    expect(queue.takeNext({ openTurn })).toBeUndefined();
    expect(queue.takeNext()).toMatchObject({
      delivery: { auth: bob, payloads: [{ message: "bob here" }, { message: "and stop" }] },
      sequences: [bobText, bobMixed],
    });
  });
});
