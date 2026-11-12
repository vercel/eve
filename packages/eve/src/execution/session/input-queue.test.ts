import type { SessionAuthContext } from "#channel/types.js";
import { describe, expect, it } from "vitest";

import { SessionInputQueue } from "#execution/session/input-queue.js";
import { principalOf } from "#context/session-auth.js";

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

  it("lets anyone steer a turn, and lets a queued message join one that waits on a person", () => {
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

    const queuedEarly = send("Invite the design team too.", alice, "queue");
    const fromBob = send("Add a meeting to my calendar.", bob);
    const heldSince = queue.nextAdmission;
    const queuedByBob = send("Book the large room.", bob, "queue");
    const admitted = new Set([queuedEarly, fromBob, queuedByBob]);

    // Bob's message steers Alice's turn; queued messages wait while nothing holds it.
    expect(queue.takeSteering(admitted, turn)?.sequences).toEqual([fromBob]);
    expect(queue.hasSteering(admitted, turn)).toBe(false);
    // A turn that waits on a person can't end until they act, so a queued message sent since
    // joins it, whoever sent it. One sent before the request existed waits for the next turn.
    expect(queue.takeSteering(admitted, turn, { heldSince })?.sequences).toEqual([queuedByBob]);
    expect(queue.takeNext()).toMatchObject({ delivery: { auth: alice }, sequences: [queuedEarly] });
  });

  it("takes one person's messages per step, so each is recorded as its sender's", () => {
    const user = (principalId: string) => ({
      attributes: {},
      authenticator: "slack",
      principalId,
      principalType: "user" as const,
    });
    const [alice, bob] = [user("ALICE"), user("BOB")];
    const queue = new SessionInputQueue([]);
    const turn = { callerCallId: undefined, principal: principalOf(alice) };
    const send = (message: string, auth?: SessionAuthContext) =>
      queue.enqueueDelivery({
        ...(auth !== undefined && { auth }),
        kind: "deliver",
        payloads: [{ message }],
      })!.sequence;
    const first = [send("It's the retry logic.", bob), send("In foo.ts.")];
    const second = send("Thanks, that helps.", alice);
    const admitted = new Set([...first, second]);

    expect(queue.takeSteering(admitted, turn)).toMatchObject({
      delivery: { auth: bob },
      sequences: first,
    });
    expect(queue.takeSteering(admitted, turn)).toMatchObject({
      delivery: { auth: alice },
      sequences: [second],
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
