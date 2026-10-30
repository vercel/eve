import { describe, expect, it } from "vitest";

import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionStateMap } from "#harness/types.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
import { saveTransition } from "#harness/session-machine/commit.js";
import { holdsHitlRequests, readHitlState, writeHitlState } from "./requests.js";
import type { Relay } from "./relays.js";

function signIn(name: string, attemptId: string): AuthorizationChallenge {
  return {
    attemptId,
    challenge: { instructions: `Sign in to ${name}.` },
    hookUrl: `https://example.com/${attemptId}`,
    name,
    principal: { id: "alice", type: "user" },
  };
}

function route(token: string): Relay {
  return { childContinuationToken: token };
}

function save(state: SessionStateMap | undefined, change: Parameters<typeof writeHitlState>[1]) {
  return writeHitlState({ state }, change).state;
}

describe("writeHitlState", () => {
  it("writes sign-ins and relay routes, and leaves records the change doesn't name", () => {
    const state = save(undefined, {
      relays: { "q-1": route("child") },
      signIns: [signIn("github", "a-1")],
    });
    expect(Object.keys(state ?? {})).toEqual(["eve.runtime.hitl.requests"]);
    const hitl = readHitlState(state);
    expect(hitl.signIns.map((challenge) => challenge.attemptId)).toEqual(["a-1"]);
    expect([...hitl.relays.keys()]).toEqual(["q-1"]);
    const after = readHitlState(save(state, { signIns: [] }));
    expect(after.signIns).toEqual([]);
    expect([...after.relays.keys()]).toEqual(["q-1"]);
  });

  it("keeps a dynamic remote child's binding across persisted upserts", () => {
    const remoteRoute: Relay = {
      childContinuationToken: "child",
      remote: {
        name: "billing",
        url: "https://billing.example.com",
        sessionId: "s-child",
        resolverId: "agent/subagents/billing",
        dynamicBinding: {
          session: { id: "s-parent" },
          at: "2026-01-01T00:00:00.000Z",
          position: 3,
          memos: { "k-1": { token: "t" } },
        },
      },
    };
    const first = save(undefined, { relays: { "q-1": remoteRoute } });
    const persisted = JSON.parse(JSON.stringify(first)) as SessionStateMap;
    const after = save(persisted, { relays: { "q-2": route("other") } });
    expect(readHitlState(after).relays.get("q-1")).toEqual(remoteRoute);
  });
});

describe("holdsHitlRequests", () => {
  it("is false for a session with no sign-in or relay records", () => {
    expect(holdsHitlRequests(undefined)).toBe(false);
    expect(holdsHitlRequests({ "eve.unrelated": true })).toBe(false);
    expect(holdsHitlRequests({ "eve.runtime.hitl.requests": { responders: {} } })).toBe(false);
  });

  it.each([
    [],
    42,
    { signIns: false },
    { signIns: [] },
    { relays: 42 },
    { relays: { request: {} } },
  ])("keeps unreadable records blocking handoff even after cleanup: %j", (raw) => {
    const state = { "eve.runtime.hitl.requests": raw };
    expect(holdsHitlRequests(state)).toBe(true);
    const saved = saveTransition(
      { state },
      { events: [], turn: { remembered: {}, suspended: [] } },
    );
    const cleaned = writeHitlState(saved, {}, emptySessionView());
    expect(holdsHitlRequests(cleaned.state)).toBe(true);
  });

  it("is true for a pending sign-in or relayed request", () => {
    expect(holdsHitlRequests(save(undefined, { signIns: [signIn("github", "a-1")] }))).toBe(true);
    expect(holdsHitlRequests(save(undefined, { relays: { "q-1": route("child") } }))).toBe(true);
  });
});
