import { describe, expect, it } from "vitest";

import type { SessionEvent } from "#protocol/session-event.js";
import type { HarnessSession } from "#harness/types.js";
import { withPublished, withRelays } from "#internal/testing/session-machine.js";
import { routeDeliverPayload } from "#subagents/hitl-proxy.js";

function createSession(): HarnessSession {
  return {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "parent-token",
    history: [],
    sessionId: "parent-session",
  };
}

function opened(
  interactionId: string,
  request: { readonly kind: string; readonly prompt: string; readonly options?: unknown },
  relayed = true,
): SessionEvent {
  return {
    data: {
      interactionId,
      request,
      subject: { turnId: "turn_0" },
      ...(relayed && { origin: { interactionId, sessionId: "child" } }),
    },
    scope: { turnId: "turn_0" },
    type: "interaction.opened",
  } as SessionEvent;
}

const started: SessionEvent[] = [
  { data: {}, type: "session.started" },
  {
    data: { cause: { deliveryId: "d0" }, follows: null, turnId: "turn_0" },
    type: "turn.started",
  } as SessionEvent,
];

describe("routeDeliverPayload", () => {
  it("sends each answer to its asker by interaction id, and keeps the rest", () => {
    const session = withRelays(
      withPublished(createSession(), [
        ...started,
        opened("a", { kind: "question", prompt: "A?" }),
        opened("b", { kind: "question", prompt: "B?" }),
      ]),
      {
        a: { childContinuationToken: "child-a" },
        b: { childContinuationToken: "child-b", childSessionInbox: { sessionId: "child-b" } },
      },
    );
    const routed = routeDeliverPayload({
      payload: {
        answers: [
          { interactionId: "a", text: "1" },
          { interactionId: "b", text: "2" },
          { interactionId: "mine", text: "3" },
        ],
      },
      state: session.state,
    });
    expect(routed.forChildren).toMatchObject([
      { childContinuationToken: "child-a", payload: { answers: [{ interactionId: "a" }] } },
      {
        childContinuationToken: "child-b",
        childSessionInbox: { sessionId: "child-b" },
        payload: { answers: [{ interactionId: "b" }] },
      },
    ]);
    expect(routed.forSelf).toEqual({ answers: [{ interactionId: "mine", text: "3" }] });
  });

  it("answers the first open request with a typed reply only when a child asked it", () => {
    const relayedFirst = withRelays(
      withPublished(createSession(), [
        ...started,
        opened("a", { kind: "question", options: [{ id: "yes", label: "Yes" }], prompt: "A?" }),
      ]),
      { a: { childContinuationToken: "child-a" } },
    );
    const routed = routeDeliverPayload({
      payload: { message: "yes" },
      resolveMessage: true,
      state: relayedFirst.state,
    });
    expect(routed.forChildren[0]?.payload.answers).toEqual([
      { interactionId: "a", optionId: "yes" },
    ]);
    expect(routed.forSelf).toBeUndefined();

    const ownFirst = withRelays(
      withPublished(createSession(), [
        ...started,
        opened("mine", { kind: "question", prompt: "Mine?" }, false),
        opened("a", { kind: "question", prompt: "A?" }),
      ]),
      { a: { childContinuationToken: "child-a" } },
    );
    const kept = routeDeliverPayload({
      payload: { message: "hello" },
      resolveMessage: true,
      state: ownFirst.state,
    });
    expect(kept.forChildren).toEqual([]);
    expect(kept.forSelf).toEqual({ message: "hello" });
  });

  it("cancels the turn when a child's budget prompt is stopped", () => {
    const session = withRelays(
      withPublished(createSession(), [
        ...started,
        opened("limit", { kind: "budget", prompt: "?" }),
      ]),
      { limit: { childContinuationToken: "child" } },
    );
    const routed = routeDeliverPayload({
      payload: { answers: [{ interactionId: "limit", optionId: "deny" }] },
      state: session.state,
    });
    expect(routed.parentAction).toMatchObject({ kind: "cancel-turn" });
  });
});
