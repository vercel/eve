import { describe, expect, it } from "vitest";

import type { DeliverHookPayload, SessionAuthContext } from "#channel/types.js";
import {
  holdDelivery,
  holdSignIns,
  NOTHING_HELD,
  takeNext,
  takeSignIns,
  takeSteering,
  type Held,
} from "#execution/session/scheduler/held.js";

describe("what a session holds", () => {
  it("resumes a turn holding several sign-ins only once every one has called back", () => {
    const attempts = new Set(["linear-1", "notion-1"]);
    const linear = holdSignIns(NOTHING_HELD, [signInCallback("linear-1")]);
    expect(takeSignIns(linear, attempts).payloads).toBeUndefined();

    const both = holdSignIns(linear, [signInCallback("notion-1")]);
    const taken = takeSignIns(both, attempts);
    expect(taken.payloads).toEqual([signInCallback("linear-1"), signInCallback("notion-1")]);
    expect(takeSignIns(taken.held, attempts).payloads).toBeUndefined();
  });

  it("lets a queued message steer a held turn only when it arrived after the hold", () => {
    const turn = { callerCallId: undefined, principal: "user:test:alice" };
    const queued = (message: string): DeliverHookPayload => ({
      kind: "deliver",
      payloads: [{ message }],
      turnPolicy: "queue",
    });
    const before = holdDelivery(NOTHING_HELD, queued("approve"));
    const heldSince = before.held.next;
    const after = holdDelivery(before.held, queued("never mind"));
    const admitted = [before.sequence, after.sequence];

    expect(takeSteering(after.held, admitted, turn).selection).toBeUndefined();
    const steered = takeSteering(after.held, admitted, turn, heldSince);
    expect(steered.selection?.sequences).toEqual([after.sequence]);
    expect(takeNext(steered.held).taken).toMatchObject({ sequences: [before.sequence] });
  });

  it("starts a turn with one principal's adjacent deliveries, with their latest claims", () => {
    const auth = slackAuth("bob");
    const refreshed = { ...auth, attributes: { scopes: ["read", "write"], team: "support" } };
    const first = delivery("first", auth);
    const second = delivery("second", refreshed);

    const { held, taken } = takeNext(holding(first, second));

    expect(taken).toMatchObject({
      delivery: {
        auth: refreshed,
        deliveryMetadata: [
          first.deliveryMetadata![0],
          { ...second.deliveryMetadata![0], payloadIndex: 1 },
        ],
        payloads: [...first.payloads, ...second.payloads],
      },
      kind: "turn",
    });
    expect(held.entries).toEqual([]);
  });

  it("keeps different principals in arrival order, without regrouping later messages", () => {
    const alice = slackAuth("alice");
    const bob = slackAuth("bob");
    const turns = takeAll(
      holding(
        delivery("alice-1", alice),
        delivery("alice-2", alice),
        delivery("bob", bob),
        delivery("alice-3", alice),
      ),
    );

    expect(turns.map((turn) => turn.payloads.map((payload) => payload.message))).toEqual([
      ["alice-1", "alice-2"],
      ["bob"],
      ["alice-3"],
    ]);
  });

  it("starts a turn with one delegated call's messages, and stops at another call", () => {
    const auth = slackAuth("alice");
    const fromCall = (message: string, callId: string): DeliverHookPayload => ({
      ...delivery(message, auth),
      caller: {
        callId,
        replyTo: { kind: "hook", token: `${message}-reply` },
        subagentName: "keeper",
      },
    });

    const turns = takeAll(
      holding(
        fromCall("first", "call-1"),
        fromCall("correction", "call-1"),
        fromCall("other", "call-2"),
      ),
    );

    // The turn answers the latest message's reply address.
    expect(turns).toMatchObject([
      {
        caller: { callId: "call-1", replyTo: { token: "correction-reply" } },
        payloads: [{ message: "first" }, { message: "correction" }],
      },
      { caller: { callId: "call-2" }, payloads: [{ message: "other" }] },
    ]);
  });

  it.each([{ authenticator: "other" }, { issuer: "other" }, { principalType: "service" as const }])(
    "starts separate turns when the principal changes: %j",
    (change) => {
      const auth = slackAuth("alice");
      const first = delivery("first", auth);

      const { held, taken } = takeNext(holding(first, delivery("second", { ...auth, ...change })));

      expect(taken).toMatchObject({ delivery: first, kind: "turn" });
      expect(held.entries).toHaveLength(1);
    },
  );

  it.each([null, undefined])("starts separate turns for deliveries with auth %j", (auth) => {
    const first: DeliverHookPayload = { auth, kind: "deliver", payloads: [{ message: "first" }] };
    const second: DeliverHookPayload = { auth, kind: "deliver", payloads: [{ message: "second" }] };

    const { held, taken } = takeNext(holding(first, second));

    expect(taken).toMatchObject({ delivery: first, kind: "turn" });
    expect(held.entries).toHaveLength(1);
  });

  it("drops a sign-in callback still held between turns: it ended with the turn that asked", () => {
    const signedIn = holdSignIns(NOTHING_HELD, [signInCallback("weather-1")]);
    const next = holdDelivery(signedIn, delivery("next question", slackAuth("alice")));

    expect(takeNext(next.held)).toMatchObject({
      held: { entries: [] },
      taken: { delivery: { payloads: [{ message: "next question" }] }, kind: "turn" },
    });
  });

  it("hands off only a lone, callerless delivery that arrived while nothing else was held", () => {
    const alone = holdDelivery(NOTHING_HELD, delivery("alone", slackAuth("alice")));
    const behind = holdDelivery(alone.held, delivery("behind", slackAuth("bob")));
    const called = holdDelivery(NOTHING_HELD, {
      ...delivery("called", slackAuth("alice")),
      caller: {
        callId: "call-1",
        replyTo: { kind: "hook", token: "reply" },
        subagentName: "keeper",
      },
    });

    expect(takeNext(alone.held, { fresh: alone.sequence }).taken).toMatchObject({
      handoffEligible: true,
    });
    expect(takeNext(alone.held).taken).toMatchObject({ handoffEligible: false });
    expect(takeNext(behind.held, { fresh: alone.sequence }).taken).toMatchObject({
      handoffEligible: false,
    });
    expect(takeNext(called.held, { fresh: called.sequence }).taken).toMatchObject({
      handoffEligible: false,
    });
  });
});

function holding(...deliveries: DeliverHookPayload[]): Held {
  return deliveries.reduce((held, next) => holdDelivery(held, next).held, NOTHING_HELD);
}

function takeAll(held: Held): DeliverHookPayload[] {
  const turns: DeliverHookPayload[] = [];
  for (let next = takeNext(held); next.taken !== undefined; next = takeNext(next.held))
    if (next.taken.kind === "turn") turns.push(next.taken.delivery);
  return turns;
}

function signInCallback(attemptId: string) {
  return {
    authorizationCallback: {
      attemptId,
      callback: { method: "GET" as const, params: { code: "oauth-code" } },
      connectionName: attemptId.split("-")[0]!,
    },
  };
}

function slackAuth(principalId: string): SessionAuthContext {
  return {
    attributes: { scopes: ["read"], team: "support" },
    authenticator: "slack",
    issuer: "workspace",
    principalId,
    principalType: "user",
    subject: principalId,
  };
}

function delivery(message: string, auth: SessionAuthContext): DeliverHookPayload {
  return {
    auth,
    deliveryMetadata: [
      { channelKind: "slack", channelName: "slack", deliveryId: message, payloadIndex: 0 },
    ],
    kind: "deliver",
    payloads: [{ message }],
    turnPolicy: "queue",
  };
}
