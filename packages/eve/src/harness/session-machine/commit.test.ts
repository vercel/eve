import { expect, it } from "vitest";

import type { AuthorizationChallenge } from "#harness/authorization.js";
import { readHitlState, writeHitlState } from "#harness/hitl/requests.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import type { StoredLine } from "#protocol/session-events/envelope.js";
import { emptySessionView, foldLines } from "#protocol/session-projection/fold.js";
import type { SessionEvent } from "#protocol/session-event.js";

import { dropClosedRecords, sessionView } from "./commit.js";

const challenge: AuthorizationChallenge = {
  attemptId: "attempt-1",
  challenge: { instructions: "Sign in to GitHub." },
  hookUrl: "https://example.com/attempt-1",
  name: "github",
  principal: { id: "alice", type: "user" },
};

it("waits on no sign-in whose interaction closed, as when its call settled without it", () => {
  const scope = { runId: "run_0", turnId: "turn_0" };
  const opened: SessionEvent[] = [
    { data: {}, type: "session.started" },
    { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
    {
      data: { cause: { deliveryId: "d_0" }, follows: null, turnId: "turn_0" },
      scope,
      type: "turn.started",
    },
    { data: { owner: { turnId: "turn_0" }, runId: "run_0" }, scope, type: "model.requested" },
    {
      data: {
        callId: "call_1",
        capability: { kind: "tool", name: "gate" },
        input: {},
        owner: { runId: "run_0" },
      },
      scope,
      type: "call.requested",
    },
    {
      data: {
        interactionId: "attempt-1",
        request: { kind: "sign-in", prompt: "Sign in.", signIn: { name: "github" } },
        subject: { callId: "call_1" },
      },
      type: "interaction.opened",
    },
  ];
  const { state } = writeHitlState({ state: undefined }, { signIns: [challenge] });
  const projection = (lines: readonly (readonly SessionEvent[])[]): SessionProjection => {
    const view = emptySessionView();
    const stored = lines.map((facts) => ({ at: "2026-10-10T00:00:00.000Z", facts: [...facts] }));
    foldLines(view, stored as StoredLine[], 0);
    return { counters: { changes: 0, runs: 1 }, view };
  };
  const open = projection([opened]);
  expect(sessionView(open, state).signIns.map((entry) => entry.attemptId)).toEqual(["attempt-1"]);

  const closed = projection([
    opened,
    [{ data: { interactionId: "attempt-1", outcome: "interrupted" }, type: "interaction.settled" }],
  ]);
  expect(sessionView(closed, state).signIns).toEqual([]);
});

it("keeps a relay answerable until its asker settles the interaction", () => {
  const view = emptySessionView();
  const at = "2026-10-10T00:00:00.000Z";
  foldLines(
    view,
    [
      {
        at,
        facts: [
          { type: "session.started", data: {} },
          { type: "delivery.admitted", data: { deliveryId: "initial" } },
          {
            type: "turn.started",
            data: { turnId: "turn_0", follows: null, cause: { deliveryId: "initial" } },
          },
          {
            type: "interaction.opened",
            data: {
              interactionId: "approval",
              subject: { turnId: "turn_0" },
              origin: { sessionId: "child", interactionId: "approval" },
              request: { kind: "approval", prompt: "Continue?" },
            },
          },
          { type: "delivery.admitted", data: { deliveryId: "answer" } },
          {
            type: "response.submitted",
            data: {
              deliveryId: "answer",
              interactionId: "approval",
              responseId: "response",
              value: { optionId: "approve" },
            },
          },
          { type: "response.admitted", data: { responseId: "response" } },
        ],
      },
    ],
    0,
  );
  const session = writeHitlState(
    {
      agent: { modelReference: { id: "test" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 0.8 },
      continuationToken: "parent",
      sessionId: "session-1",
      state: undefined,
    },
    { relays: { approval: { childContinuationToken: "child" } } },
  );
  const projection = { counters: { changes: 0, runs: 0 }, view };
  const pending = dropClosedRecords(session, projection);
  expect(readHitlState(pending.state).relays.get("approval")).toEqual({
    childContinuationToken: "child",
  });
  foldLines(
    view,
    [
      {
        at,
        facts: [
          { type: "interaction.settled", data: { interactionId: "approval", outcome: "accepted" } },
        ],
      },
    ],
    1,
  );
  expect(readHitlState(dropClosedRecords(pending, projection).state).relays.size).toBe(0);
});
