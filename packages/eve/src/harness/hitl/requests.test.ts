import { describe, expect, it } from "vitest";

import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionStateMap } from "#harness/types.js";
import {
  discardClearedHitlState,
  holdsHitlRequests,
  readHitlState,
  writeHitlState,
} from "./requests.js";
import { type ProxyInputRequest } from "./relays.js";

const EVENT = { sequence: 1, stepIndex: 0, turnId: "turn_1" };

function signIn(name: string, attemptId: string): AuthorizationChallenge {
  return {
    attemptId,
    challenge: { instructions: `Sign in to ${name}.` },
    hookUrl: `https://example.com/${attemptId}`,
    name,
    principal: { id: "alice", type: "user" },
  };
}

function route(token: string, inputSource?: string): ProxyInputRequest {
  return {
    childContinuationToken: token,
    event: EVENT,
    ...(inputSource !== undefined && { inputSource }),
    kind: "question",
    reply: { allowFreeform: true },
  };
}

function save(state: SessionStateMap | undefined, change: Parameters<typeof writeHitlState>[1]) {
  return writeHitlState({ state }, change).state;
}

describe("writeHitlState", () => {
  it("writes the sign-ins and the relay routes a transition changes", () => {
    const state = save(undefined, {
      relays: {
        upsert: { entries: [["q-1", route("child")]], forChildContinuationToken: "child" },
      },
      signIns: [signIn("github", "a-1")],
    });
    expect(Object.keys(state ?? {})).toEqual(["eve.runtime.hitl.requests"]);
    const hitl = readHitlState(state);
    expect(hitl.signIns.map((challenge) => challenge.attemptId)).toEqual(["a-1"]);
    expect([...hitl.relays.keys()]).toEqual(["q-1"]);
  });

  it("leaves records the change doesn't name", () => {
    const before = save(undefined, {
      relays: {
        upsert: { entries: [["q-1", route("child")]], forChildContinuationToken: "child" },
      },
      signIns: [signIn("github", "a-1")],
    });
    const after = readHitlState(save(before, { relays: { retire: ["q-unknown"] } }));
    expect(after.signIns).toHaveLength(1);
    expect(after.relays.size).toBe(1);
  });

  it("withdraws every sign-in on an empty list, and retires the routes it names", () => {
    const before = save(undefined, {
      relays: {
        upsert: {
          entries: [
            ["q-1", route("child")],
            ["q-2", route("child")],
          ],
          forChildContinuationToken: "child",
        },
      },
      signIns: [signIn("github", "a-1")],
    });
    const after = save(before, { relays: { retire: ["q-1"] }, signIns: [] });
    expect(readHitlState(after).signIns).toEqual([]);
    expect([...readHitlState(after).relays.keys()]).toEqual(["q-2"]);
  });

  it("replaces only the routes of the batch's own input source", () => {
    const first = save(undefined, {
      relays: {
        upsert: {
          entries: [["q-a", route("child", "a")]],
          forChildContinuationToken: "child",
          inputSource: "a",
        },
      },
    });
    const second = save(first, {
      relays: {
        upsert: {
          entries: [["q-b", route("child", "b")]],
          forChildContinuationToken: "child",
          inputSource: "b",
        },
      },
    });
    expect([...readHitlState(second).relays.keys()].sort()).toEqual(["q-a", "q-b"]);
  });
});

describe("holdsHitlRequests", () => {
  it("is false for a session with no sign-in or relay records", () => {
    expect(holdsHitlRequests(undefined)).toBe(false);
    expect(holdsHitlRequests({ "eve.unrelated": true })).toBe(false);
    expect(holdsHitlRequests({ "eve.runtime.hitl.requests": { approvals: {} } })).toBe(false);
  });

  it("is true for a requests record it can't read", () => {
    expect(holdsHitlRequests({ "eve.runtime.hitl.requests": [] })).toBe(true);
    expect(holdsHitlRequests({ "eve.runtime.hitl.requests": { relays: 42 } })).toBe(true);
  });

  it("is true for a pending sign-in or relayed request", () => {
    expect(holdsHitlRequests(save(undefined, { signIns: [signIn("github", "a-1")] }))).toBe(true);
    const relayed = save(undefined, {
      relays: {
        upsert: { entries: [["q-1", route("child")]], forChildContinuationToken: "child" },
      },
    });
    expect(holdsHitlRequests(relayed)).toBe(true);
  });
});

describe("discardClearedHitlState", () => {
  it("drops approvals and sign-ins and keeps relayed requests", () => {
    const state = save(
      { "eve.runtime.hitl.requests": { approvals: { activeCandidates: {} } } },
      {
        relays: {
          upsert: { entries: [["q-1", route("child")]], forChildContinuationToken: "child" },
        },
        signIns: [signIn("github", "a-1")],
      },
    );
    const cleared = discardClearedHitlState({ state } as Parameters<
      typeof discardClearedHitlState
    >[0]).state;
    expect(cleared).toEqual({ "eve.runtime.hitl.requests": { relays: { "q-1": route("child") } } });
  });
});
