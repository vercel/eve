import { describe, expect, it } from "vitest";

import { deriveRunFacts } from "#evals/runner/derive-run-facts.js";
import { emptySessionView, foldEvents } from "#protocol/session-projection/public-view.js";
import { combineDerivedFacts } from "#evals/runner/execute-task.js";
import type { EveEvalSessionResult } from "#evals/types.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";

const turnId = "turn_0";

function spent(inputTokens: number, costUsd?: number): SessionEvent {
  const usage = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens, outputTokens: 1 };
  return {
    data: { kind: "model", usage: costUsd === undefined ? usage : { ...usage, costUsd } },
    type: "usage.recorded",
  } as SessionEvent;
}

/** `events` as one handle read them, from line `firstLine`, one line each. */
function handle(
  firstLine: number,
  events: readonly SessionEvent[],
  { at = "2026-10-10T00:00:00.000Z", sessionId = "session-1" } = {},
): EveEvalSessionResult {
  const stamped = events.map((event, index): SessionStreamEvent => ({
    ...event,
    meta: { at, endOfLine: true, position: { index: 0, line: firstLine + index } },
  }));
  return {
    view: foldEvents(emptySessionView(), stamped),
    derived: deriveRunFacts(stamped, { sessionId }),
    events: stamped,
    primary: true,
    sessionId,
    state: undefined,
    traceContexts: [],
  };
}

describe("combineDerivedFacts", () => {
  it("reads a held turn's handles as one stream: a resumed turn isn't parked", () => {
    const held = handle(0, [
      { data: { cause: { deliveryId: "d-1" }, follows: null, turnId }, type: "turn.started" },
      {
        data: {
          interactionId: "sign-in-1",
          request: { kind: "sign-in", prompt: "Sign in" },
          subject: { turnId },
        },
        scope: { turnId },
        type: "interaction.opened",
      },
      {
        data: { awaiting: [{ interactionId: "sign-in-1" }], turnId },
        scope: { turnId },
        type: "turn.paused",
      },
    ]);
    const resumed = handle(3, [
      {
        data: { interactionId: "sign-in-1", outcome: "accepted" },
        scope: { turnId },
        type: "interaction.settled",
      },
      { data: { outcome: "completed", turnId }, scope: { turnId }, type: "turn.settled" },
    ]);

    expect(held.derived.parked).toBe(true);
    expect(combineDerivedFacts([held, resumed])).toMatchObject({
      openInteractions: [],
      parked: false,
    });
    expect(combineDerivedFacts([held])).toMatchObject({
      openInteractions: [{ interactionId: "sign-in-1" }],
      parked: true,
    });
  });

  it("collects open requests only from the sessions that ended parked", () => {
    const completed = handle(
      0,
      [
        { data: { cause: { deliveryId: "d-1" }, follows: null, turnId }, type: "turn.started" },
        { data: { outcome: "completed", turnId }, scope: { turnId }, type: "turn.settled" },
      ],
      { sessionId: "session-1" },
    );
    const parked = handle(
      0,
      [
        { data: { cause: { deliveryId: "d-2" }, follows: null, turnId }, type: "turn.started" },
        {
          data: {
            interactionId: "approval-1",
            request: { kind: "approval", prompt: "Deploy?" },
            subject: { turnId },
          },
          scope: { turnId },
          type: "interaction.opened",
        },
        {
          data: { awaiting: [{ interactionId: "approval-1" }], turnId },
          scope: { turnId },
          type: "turn.paused",
        },
      ],
      { sessionId: "session-2" },
    );

    expect(combineDerivedFacts([completed, parked])).toMatchObject({
      openInteractions: [{ interactionId: "approval-1" }],
      parked: true,
    });
  });

  it("lists no open requests when one parked session's requests weren't read", () => {
    const read = handle(
      0,
      [
        {
          data: {
            interactionId: "approval-1",
            request: { kind: "approval", prompt: "Deploy?" },
            subject: { turnId },
          },
          scope: { turnId },
          type: "interaction.opened",
        },
        {
          data: { awaiting: [{ interactionId: "approval-1" }], turnId },
          scope: { turnId },
          type: "turn.paused",
        },
      ],
      { sessionId: "session-1" },
    );
    const unread = handle(
      5,
      [
        {
          data: { awaiting: [{ interactionId: "question-1" }], turnId },
          scope: { turnId },
          type: "turn.paused",
        },
      ],
      { sessionId: "session-2" },
    );

    expect(combineDerivedFacts([read, unread])).toMatchObject({
      openInteractions: [],
      parked: true,
    });
  });

  it("keeps a recaptured session's latest usage by time, not by capture order", () => {
    // The second capture is an earlier snapshot of the same session.
    const fuller = handle(0, [spent(10, 0.25), spent(20, 0.5)], {
      at: "2026-10-10T00:00:02.000Z",
    });
    const earlier = handle(0, [spent(10, 0.25)], { at: "2026-10-10T00:00:01.000Z" });

    expect(combineDerivedFacts([fuller, earlier]).usage).toEqual({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.75,
      inputTokens: 30,
      outputTokens: 2,
    });
  });

  it("reports tokens but no cost when a counted session reported no cost", () => {
    const priced = handle(0, [spent(5, 0.5)], { sessionId: "priced" });
    const unpriced = handle(0, [spent(7)], { sessionId: "unpriced" });

    // 0.5 would read as the eval's cost while one session's spend is unknown.
    const usage = combineDerivedFacts([priced, unpriced]).usage;
    expect(usage).toEqual({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 12,
      outputTokens: 2,
    });
    expect(usage !== undefined && "costUsd" in usage).toBe(false);
  });
});
