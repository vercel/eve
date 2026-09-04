import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  activityCollectorWorkflow,
  reduceCollectorActivity,
} from "#execution/activity-collector.js";
import { createActivitySnapshot } from "#execution/session-activity.js";
import type { ActivityBatchV1 } from "#protocol/activity.js";

const mocks = vi.hoisted(() => ({
  createHook: vi.fn(),
  disposeSessionActivityStep: vi.fn(),
  renderSessionActivityStep: vi.fn(),
  sleep: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@workflow/core/index.js")>()),
  createHook: mocks.createHook,
  sleep: mocks.sleep,
}));
vi.mock("#execution/session-activity-renderer-step.js", () => ({
  disposeSessionActivityStep: mocks.disposeSessionActivityStep,
  renderSessionActivityStep: mocks.renderSessionActivityStep,
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.disposeSessionActivityStep.mockResolvedValue(undefined);
});

const work = {
  id: "root:work",
  kind: "root-turn" as const,
  rootSessionId: "session",
  rootTurnId: "turn",
};

describe("activityCollectorWorkflow", () => {
  it.each([false, true])(
    "expires with a pending hook read (debouncing: %s)",
    async (debouncing) => {
      const expiry = Promise.withResolvers<void>();
      const reading = Promise.withResolvers<void>();
      mocks.sleep.mockImplementation((duration: Date | number) =>
        duration instanceof Date ? expiry.promise : new Promise<void>(() => {}),
      );
      mocks.createHook.mockReturnValue({
        token: "activity",
        getConflict: async () => null,
        async *[Symbol.asyncIterator]() {
          if (debouncing) {
            yield {
              events: [{ eventId: "start", kind: "work.started", startedAt: "1", work }],
              version: 1,
            } satisfies ActivityBatchV1;
          }
          reading.resolve();
          yield await new Promise<ActivityBatchV1>(() => {});
        },
      });

      const result = activityCollectorWorkflow({
        expiresAt: "2026-09-04T00:00:00Z",
        serializedContext: {},
        token: "activity",
      });
      await reading.promise;
      expiry.resolve();

      await expect(result).resolves.toBeUndefined();
      expect(mocks.disposeSessionActivityStep).toHaveBeenCalledExactlyOnceWith({
        rendererStates: {},
        serializedContext: {},
      });
    },
    1_000,
  );
});

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
