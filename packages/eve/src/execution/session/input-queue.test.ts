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

  it("lets only the turn's own person steer it and keeps another person's message for its own turn", () => {
    const alice = {
      attributes: {},
      authenticator: "slack",
      principalId: "ALICE",
      principalType: "user" as const,
    };
    const bob = { ...alice, principalId: "BOB" };
    const queue = new SessionInputQueue([]);
    const turn = { callerCallId: undefined, principal: principalOf(alice) };
    const send = (message: string, auth?: typeof alice, turnPolicy?: "queue") =>
      queue.enqueueDelivery({
        ...(auth !== undefined && { auth }),
        ...(turnPolicy !== undefined && { turnPolicy }),
        kind: "deliver",
        payloads: [{ message }],
      })!.sequence;

    const fromBob = send("Add a meeting to my calendar.", bob);
    const fromAlice = send("Also cover the launch date.", alice);
    const unauthenticated = send("Include the press notes.");
    const queuedByBob = send("Invite the design team too.", bob, "queue");
    const admitted = new Set([fromBob, fromAlice, unauthenticated, queuedByBob]);

    // A delivery without auth acts as the session's current identity, which is the turn's.
    expect(queue.takeSteering(admitted, turn)?.sequences).toEqual([fromAlice, unauthenticated]);
    // A turn held on Alice lets her queued messages steer it, but never Bob's.
    expect(queue.takeSteering(admitted, turn, { heldSince: 0 })).toBeUndefined();
    expect(queue.takeNext()).toMatchObject({
      delivery: { auth: bob },
      sequences: [fromBob, queuedByBob],
    });
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
});
