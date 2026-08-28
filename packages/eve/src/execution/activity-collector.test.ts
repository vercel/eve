import { describe, expect, it } from "vitest";

import { reduceCollectorActivity } from "#execution/activity-collector.js";
import { createActivitySnapshot } from "#execution/session-activity.js";

const work = {
  id: "root:work",
  kind: "root-turn" as const,
  rootSessionId: "session",
  rootTurnId: "turn",
};

describe("reduceCollectorActivity", () => {
  it("marks only presentation revision advances as changed", () => {
    const visible = reduceCollectorActivity(createActivitySnapshot(), {
      events: [{ eventId: "start", kind: "work.started", startedAt: "1", work }],
      version: 1,
    });
    expect(visible.presentationChanged).toBe(true);

    const bookkeeping = reduceCollectorActivity(visible.snapshot, {
      events: [
        {
          blockerId: "missing",
          eventId: "settled-before-start",
          kind: "blocker.settled",
          outcome: "completed",
          settledAt: "2",
        },
      ],
      version: 1,
    });
    expect(bookkeeping.presentationChanged).toBe(false);
    expect(bookkeeping.snapshot.revision).toBe(visible.snapshot.revision);

    const settled = reduceCollectorActivity(bookkeeping.snapshot, {
      events: [
        {
          eventId: "work-settled",
          kind: "work.settled",
          outcome: "completed",
          settledAt: "3",
          workId: work.id,
        },
      ],
      version: 1,
    });
    expect(settled.presentationChanged).toBe(true);
  });
});
