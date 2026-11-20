import { describe, expect, it } from "vitest";

import {
  CONNECTION_EVENT_CHANNEL_KIND,
  SUBSCRIPTION_CHANNEL_KIND,
} from "#channel/delivery-metadata.js";
import { isSteeringDelivery, SessionInputQueue } from "#execution/session/input-queue.js";
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

    expect(queue.takeSteering(admitted, turn)?.sequences).toEqual([fromAlice, unauthenticated]);
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

  describe("deliveries from an outside event source", () => {
    const alice = {
      attributes: {},
      authenticator: "slack",
      principalId: "ALICE",
      principalType: "user" as const,
    };
    const turn = { callerCallId: undefined, principal: principalOf(alice) };
    const metadataOf = (channelKind: string) => [
      { channelKind, channelName: "github", deliveryId: "d1", payloadIndex: 0 },
    ];
    const deliveryOf = (channelKind?: string) => ({
      auth: alice,
      kind: "deliver" as const,
      payloads: [{ message: "Checks finished." }],
      turnPolicy: "queue" as const,
      ...(channelKind !== undefined && { deliveryMetadata: metadataOf(channelKind) }),
    });

    it("steers for a same-principal queued message held on the person, as the control", () => {
      expect(isSteeringDelivery(deliveryOf(), turn, { heldOnPerson: true })).toBe(true);
      expect(isSteeringDelivery(deliveryOf("slack"), turn, { heldOnPerson: true })).toBe(true);
    });

    it.each([SUBSCRIPTION_CHANNEL_KIND, CONNECTION_EVENT_CHANNEL_KIND])(
      "never steers a %s delivery, even from the turn's own principal held on the person",
      (channelKind) => {
        const delivery = deliveryOf(channelKind);
        expect(principalOf(delivery.auth)).toBe(turn.principal);
        expect(isSteeringDelivery(delivery, turn, { heldOnPerson: true })).toBe(false);
        expect(isSteeringDelivery(delivery, turn)).toBe(false);
        expect(isSteeringDelivery({ ...delivery, turnPolicy: undefined }, turn)).toBe(false);
      },
    );

    it.each([SUBSCRIPTION_CHANNEL_KIND, CONNECTION_EVENT_CHANNEL_KIND])(
      "keeps a %s delivery queued past takeSteering for the next turn",
      (channelKind) => {
        const queue = new SessionInputQueue([]);
        const heldSince = queue.nextAdmission;
        const ordinary = queue.enqueueDelivery(deliveryOf())!.sequence;
        const event = queue.enqueueDelivery(deliveryOf(channelKind))!.sequence;
        const admitted = new Set([ordinary, event]);

        expect(queue.takeSteering(admitted, turn, { heldSince })?.sequences).toEqual([ordinary]);
        expect(queue.takeSteering(admitted, turn, { heldSince })).toBeUndefined();
        expect(queue.takeNext()).toMatchObject({ kind: "turn", sequences: [event] });
      },
    );
  });
});
