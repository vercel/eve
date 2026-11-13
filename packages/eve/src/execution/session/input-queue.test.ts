import { describe, expect, it } from "vitest";

import { SessionInputQueue } from "#execution/session/input-queue.js";
import { principalOf, steeredByAfter } from "#execution/session/principal.js";

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

  it("lets another person's retain-caller message join a turn that isn't waiting on its caller", () => {
    const alice = {
      attributes: {},
      authenticator: "slack",
      principalId: "ALICE",
      principalType: "user" as const,
    };
    const bob = { ...alice, principalId: "BOB" };
    const turn = { callerCallId: undefined, principal: principalOf(alice) };
    const send = (
      queue: SessionInputQueue,
      message: string,
      auth: typeof alice | null | undefined,
      retain = false,
    ) =>
      queue.enqueueDelivery({
        ...(auth !== undefined && { auth }),
        ...(retain && { principalPolicy: "retain-caller" as const }),
        kind: "deliver",
        payloads: [{ message }],
      })!.sequence;

    const retaining = new SessionInputQueue([]);
    const retainedByBob = send(retaining, "Actually include everyone.", bob, true);
    const matchingByBob = send(retaining, "And book a room.", bob);
    const admitted = new Set([retainedByBob, matchingByBob]);
    expect(retaining.takeSteering(admitted, turn)?.sequences).toEqual([retainedByBob]);
    // Without `retain-caller` his message still waits for the turn to end.
    expect(retaining.takeSteering(admitted, turn)).toBeUndefined();

    const paused = new SessionInputQueue([]);
    const whilePaused = send(paused, "Actually include everyone.", bob, true);
    const pausedAdmitted = new Set([whilePaused]);
    expect(paused.takeSteering(pausedAdmitted, turn, { paused: true })).toBeUndefined();
    // It joins when the turn resumes.
    expect(paused.takeSteering(pausedAdmitted, turn)?.sequences).toEqual([whilePaused]);

    const anonymous = new SessionInputQueue([]);
    const noSender = send(anonymous, "Include the press notes.", null, true);
    expect(anonymous.takeSteering(new Set([noSender]), turn)).toBeUndefined();

    const both = new SessionInputQueue([]);
    const fromAlice = send(both, "Also cover the launch date.", alice);
    const afterAlice = send(both, "Actually include everyone.", bob, true);
    const bothAdmitted = new Set([fromAlice, afterAlice]);
    // One step reads one sender, so the other's message waits for the next boundary.
    expect(both.takeSteering(bothAdmitted, turn)?.sequences).toEqual([fromAlice]);
    expect(both.takeSteering(bothAdmitted, turn)?.sequences).toEqual([afterAlice]);
  });

  it("lets another person's adopt-sender message join, one policy per step", () => {
    const alice = {
      attributes: {},
      authenticator: "slack",
      principalId: "ALICE",
      principalType: "user" as const,
    };
    const bob = { ...alice, principalId: "BOB" };
    const turn = { callerCallId: undefined, principal: principalOf(alice) };
    const send = (
      queue: SessionInputQueue,
      message: string,
      auth: typeof alice | null | undefined,
      options: {
        readonly principalPolicy?: "retain-caller" | "adopt-sender";
        readonly steeredBy?: readonly (typeof bob)[];
      } = {},
    ) =>
      queue.enqueueDelivery({
        ...(auth !== undefined && { auth }),
        ...(options.principalPolicy !== undefined && {
          principalPolicy: options.principalPolicy,
        }),
        ...(options.steeredBy !== undefined && { steeredBy: options.steeredBy }),
        kind: "deliver",
        payloads: [{ message }],
      })!.sequence;

    const adopting = new SessionInputQueue([]);
    const adoptByBob = send(adopting, "Actually include everyone.", bob, {
      principalPolicy: "adopt-sender",
    });
    expect(adopting.takeSteering(new Set([adoptByBob]), turn)?.sequences).toEqual([adoptByBob]);

    const paused = new SessionInputQueue([]);
    const whilePaused = send(paused, "Actually include everyone.", bob, {
      principalPolicy: "adopt-sender",
    });
    const pausedAdmitted = new Set([whilePaused]);
    expect(paused.takeSteering(pausedAdmitted, turn, { paused: true })).toBeUndefined();
    expect(paused.takeSteering(pausedAdmitted, turn)?.sequences).toEqual([whilePaused]);

    const policies = new SessionInputQueue([]);
    const retainedByBob = send(policies, "Look at the launch numbers.", bob, {
      principalPolicy: "retain-caller",
    });
    const adoptedByBob = send(policies, "Actually include everyone.", bob, {
      principalPolicy: "adopt-sender",
    });
    const policyAdmitted = new Set([retainedByBob, adoptedByBob]);
    // One person's two policies never share a step: the second leaves its own turn.
    expect(policies.takeSteering(policyAdmitted, turn)?.sequences).toEqual([retainedByBob]);
    expect(policies.takeSteering(policyAdmitted, turn)?.sequences).toEqual([adoptedByBob]);

    const merged = new SessionInputQueue([]);
    const firstWithout = send(merged, "Also cover the launch date.", alice);
    const secondWith = send(merged, "Actually include everyone.", alice, { steeredBy: [bob] });
    const batched = merged.takeSteering(new Set([firstWithout, secondWith]), turn)?.delivery;
    // The later message's list wins, even when it is the only one that carries one.
    expect(batched?.steeredBy).toEqual([bob]);

    const reverse = new SessionInputQueue([]);
    const firstWith = send(reverse, "Actually include everyone.", alice, { steeredBy: [bob] });
    const secondWithout = send(reverse, "Also cover the launch date.", alice);
    const emptied = reverse.takeSteering(new Set([firstWith, secondWithout]), turn)?.delivery;
    // An earlier message's list must not survive the merge; a parent that omits it means empty.
    expect(emptied && "steeredBy" in emptied).toBe(false);
  });

  it("keeps the turn's steered list unless its caller is the sender", () => {
    const alice = {
      attributes: {},
      authenticator: "slack",
      principalId: "ALICE",
      principalType: "user" as const,
    };
    const bob = { ...alice, principalId: "BOB" };
    const steered = [bob];

    // Input without a sender could be anyone's, so it cannot release the caller's hold.
    expect(steeredByAfter(steered, alice, undefined)).toBe(steered);
    expect(steeredByAfter(steered, alice, null)).toBe(steered);
    // Only the caller's own message releases it.
    expect(steeredByAfter(steered, alice, alice)).toEqual([]);
    // Anyone else is listed once, so a repeat leaves the list alone.
    expect(steeredByAfter(steered, alice, bob)).toBe(steered);
    expect(steeredByAfter([], alice, bob)).toEqual([bob]);
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
