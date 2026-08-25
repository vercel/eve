import { describe, expect, it } from "vitest";

import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import { parseActivityBatchV1, type ActivityEventV1 } from "#protocol/activity.js";

const work = {
  id: "root:session:turn",
  kind: "root-turn" as const,
  rootSessionId: "session",
  rootTurnId: "turn",
};

function reduce(events: readonly ActivityEventV1[]) {
  return reduceActivityBatch(createActivitySnapshot(), { events, version: 1 });
}

describe("activity protocol and reducer", () => {
  it("retains known siblings while ignoring additive unknown events", () => {
    expect(
      parseActivityBatchV1({
        events: [
          { eventId: "future", kind: "detail.updated", message: "working" },
          { eventId: "started", kind: "work.started", startedAt: "2026-01-01", work },
        ],
        version: 1,
      }),
    ).toEqual({
      events: [{ eventId: "started", kind: "work.started", startedAt: "2026-01-01", work }],
      version: 1,
    });
  });

  it("rejects malformed known events", () => {
    expect(
      parseActivityBatchV1({
        events: [{ eventId: "started", kind: "work.started", work }],
        version: 1,
      }),
    ).toBeUndefined();
  });

  it("deduplicates only by event id", () => {
    const event = { eventId: "started", kind: "work.started" as const, startedAt: "now", work };
    const first = reduce([event]);
    const duplicate = reduceActivityBatch(first, { events: [event], version: 1 });
    expect(duplicate).toBe(first);
  });

  it("applies settlement before start and never reopens terminal work", () => {
    const settled = reduce([
      {
        eventId: "settled",
        kind: "work.settled",
        outcome: "completed",
        settledAt: "later",
        workId: work.id,
      },
    ]);
    const started = reduceActivityBatch(settled, {
      events: [{ eventId: "started", kind: "work.started", startedAt: "earlier", work }],
      version: 1,
    });
    const duplicateStart = reduceActivityBatch(started, {
      events: [{ eventId: "started-again", kind: "work.started", startedAt: "latest", work }],
      version: 1,
    });
    expect(started.work[work.id]?.phase).toBe("completed");
    expect(duplicateStart.work[work.id]).toBe(started.work[work.id]);
  });

  it("retains unmatched settlement without changing revision", () => {
    const initial = createActivitySnapshot();
    const next = reduceActivityBatch(initial, {
      events: [
        {
          blockerId: "authorization:work:attempt",
          eventId: "settled",
          kind: "blocker.settled",
          outcome: "completed",
          settledAt: "now",
        },
      ],
      version: 1,
    });
    expect(next.revision).toBe(0);
    expect(next.pendingSettlements).toHaveProperty("blocker:authorization:work:attempt");
  });

  it("cancels running owned actions and blockers when work settles", () => {
    const snapshot = reduce([
      { eventId: "work", kind: "work.started", startedAt: "1", work },
      {
        action: {
          id: "action",
          kind: "tool",
          name: "search",
          parentWorkId: work.id,
          rootTurnId: "turn",
          stepIndex: 0,
        },
        eventId: "action",
        kind: "action.started",
        startedAt: "2",
      },
      {
        blocker: {
          id: "input",
          kind: "input",
          parentWorkId: work.id,
          rootTurnId: "turn",
        },
        eventId: "input",
        kind: "blocker.started",
        startedAt: "3",
      },
      {
        eventId: "settled",
        kind: "work.settled",
        outcome: "failed",
        settledAt: "4",
        workId: work.id,
      },
    ]);
    expect(snapshot.actions.action?.phase).toBe("cancelled");
    expect(snapshot.blockers.input?.phase).toBe("cancelled");
  });
});
