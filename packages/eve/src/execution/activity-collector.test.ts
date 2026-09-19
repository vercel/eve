import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  activityCollectorWorkflow,
  hasActiveActivity,
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
  it("flushes the final buffered snapshot when the activity stream closes", async () => {
    mocks.sleep.mockImplementation(() => new Promise<void>(() => {}));
    mocks.createHook.mockReturnValue({
      token: "activity",
      getConflict: async () => null,
      async *[Symbol.asyncIterator]() {
        yield {
          events: [{ eventId: "start", kind: "work.started", startedAt: "1", work }],
          version: 1,
        } satisfies ActivityBatchV1;
        yield {
          events: [
            {
              eventId: "settled",
              kind: "work.settled",
              outcome: "completed",
              settledAt: "2",
              workId: work.id,
            },
          ],
          version: 1,
        } satisfies ActivityBatchV1;
      },
    });
    mocks.renderSessionActivityStep.mockResolvedValue({ rendererStates: { slack: "rendered" } });

    await expect(
      activityCollectorWorkflow({
        expiresAt: "2026-09-04T00:00:00Z",
        serializedContext: {},
        token: "activity",
      }),
    ).resolves.toBeUndefined();

    expect(mocks.renderSessionActivityStep).toHaveBeenCalledExactlyOnceWith({
      rendererStates: {},
      serializedContext: {},
      snapshot: expect.objectContaining({
        work: expect.objectContaining({
          [work.id]: expect.objectContaining({ phase: "completed", settledAt: "2" }),
        }),
      }),
    });
    expect(mocks.disposeSessionActivityStep).toHaveBeenCalledExactlyOnceWith({
      rendererStates: { slack: "rendered" },
      serializedContext: {},
    });
  });

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

describe("periodic activity refresh", () => {
  it("re-renders active snapshots without another event", async () => {
    const expiry = Promise.withResolvers<void>();
    const debounce = Promise.withResolvers<void>();
    const refresh = Promise.withResolvers<void>();
    const refreshScheduled = Promise.withResolvers<void>();
    const secondRender = Promise.withResolvers<void>();
    mocks.sleep.mockImplementation((duration: Date | number) => {
      if (duration instanceof Date) return expiry.promise;
      if (duration === 350) return debounce.promise;
      refreshScheduled.resolve();
      return refresh.promise;
    });
    mocks.renderSessionActivityStep.mockImplementation(async () => {
      if (mocks.renderSessionActivityStep.mock.calls.length === 2) secondRender.resolve();
      return { rendererStates: {} };
    });
    mocks.createHook.mockReturnValue({
      token: "activity",
      getConflict: async () => null,
      async *[Symbol.asyncIterator]() {
        yield {
          events: [{ eventId: "start", kind: "work.started", startedAt: "1", work }],
          version: 1,
        } satisfies ActivityBatchV1;
        yield await new Promise<ActivityBatchV1>(() => {});
      },
    });

    const result = activityCollectorWorkflow({
      expiresAt: "2026-09-04T00:00:00Z",
      periodicRefreshIntervalMs: 5_000,
      serializedContext: {},
      token: "activity",
    });
    debounce.resolve();
    await refreshScheduled.promise;
    expect(mocks.renderSessionActivityStep).toHaveBeenCalledOnce();
    refresh.resolve();
    await secondRender.promise;
    expect(mocks.renderSessionActivityStep).toHaveBeenCalledTimes(2);
    expiry.resolve();
    await expect(result).resolves.toBeUndefined();
  });

  it("consumes an existing refresh timer without rendering after settlement", async () => {
    const expiry = Promise.withResolvers<void>();
    const firstDebounce = Promise.withResolvers<void>();
    const secondDebounce = Promise.withResolvers<void>();
    const refresh = Promise.withResolvers<void>();
    const settlement = Promise.withResolvers<ActivityBatchV1>();
    const firstRefreshScheduled = Promise.withResolvers<void>();
    const secondDebounceScheduled = Promise.withResolvers<void>();
    let debounceCount = 0;
    mocks.sleep.mockImplementation((duration: Date | number) => {
      if (duration instanceof Date) return expiry.promise;
      if (duration === 350) {
        debounceCount += 1;
        if (debounceCount === 2) secondDebounceScheduled.resolve();
        return debounceCount === 1 ? firstDebounce.promise : secondDebounce.promise;
      }
      firstRefreshScheduled.resolve();
      return refresh.promise;
    });
    mocks.renderSessionActivityStep.mockResolvedValue({ rendererStates: {} });
    mocks.createHook.mockReturnValue({
      token: "activity",
      getConflict: async () => null,
      async *[Symbol.asyncIterator]() {
        yield {
          events: [{ eventId: "start", kind: "work.started", startedAt: "1", work }],
          version: 1,
        } satisfies ActivityBatchV1;
        yield await settlement.promise;
        yield await new Promise<ActivityBatchV1>(() => {});
      },
    });

    const result = activityCollectorWorkflow({
      expiresAt: "2026-09-04T00:00:00Z",
      periodicRefreshIntervalMs: 5_000,
      serializedContext: {},
      token: "activity",
    });
    firstDebounce.resolve();
    await firstRefreshScheduled.promise;
    settlement.resolve({
      events: [
        {
          eventId: "settled",
          kind: "work.settled",
          outcome: "completed",
          settledAt: "2",
          workId: work.id,
        },
      ],
      version: 1,
    });
    await secondDebounceScheduled.promise;
    secondDebounce.resolve();
    await vi.waitFor(() => expect(mocks.renderSessionActivityStep).toHaveBeenCalledTimes(2));
    refresh.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.renderSessionActivityStep).toHaveBeenCalledTimes(2);
    expiry.resolve();
    await expect(result).resolves.toBeUndefined();
  });

  it("identifies only running or blocked snapshots as active", () => {
    const active = reduceCollectorActivity(createActivitySnapshot(), {
      events: [{ eventId: "start", kind: "work.started", startedAt: "1", work }],
      version: 1,
    }).snapshot;
    expect(hasActiveActivity(active)).toBe(true);

    const settled = reduceCollectorActivity(active, {
      events: [
        {
          eventId: "settled",
          kind: "work.settled",
          outcome: "completed",
          settledAt: "2",
          workId: work.id,
        },
      ],
      version: 1,
    }).snapshot;
    expect(hasActiveActivity(settled)).toBe(false);
  });
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
