import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLocalDevScheduleStore,
  type LocalDevScheduleClaim,
  type LocalDevScheduleRow,
  type LocalDevScheduleStore,
} from "#internal/schedules/local-dev-store.js";
import { startLocalDevScheduleTimer } from "#internal/schedules/local-dev-timer.js";

const START = Date.parse("2026-09-28T12:00:00.000Z");
let directory: string;
let store: LocalDevScheduleStore;

function row(name: string, at: string): LocalDevScheduleRow {
  return {
    collection: "wake",
    namespace: "ns",
    name,
    scheduleId: `local_${name}`,
    state: "active",
    expression: { type: "single", at, timezone: "UTC" },
    payload: null,
    nextFireAtMs: Date.parse(`${at}:00.000Z`),
    createdAt: START,
    updatedAt: START,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  directory = mkdtempSync(join(tmpdir(), "eve-local-dev-timer-"));
  store = createLocalDevScheduleStore({ dbPath: join(directory, "schedules.db") });
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("startLocalDevScheduleTimer", () => {
  it("dispatches a schedule when it comes due and not before", async () => {
    store.put(row("a", "2026-09-28T12:01"));
    const dispatched: LocalDevScheduleClaim[] = [];
    const timer = startLocalDevScheduleTimer({
      store,
      dispatch: async (claim) => void dispatched.push(claim),
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(dispatched).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatched.map(({ row: { name } }) => name)).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(dispatched).toHaveLength(1);
    timer.stop();
  });

  it("re-arms for a schedule written after it started, with no polling", async () => {
    const dispatched: string[] = [];
    const timer = startLocalDevScheduleTimer({
      store,
      dispatch: async ({ row: { name } }) => void dispatched.push(name),
    });
    expect(vi.getTimerCount()).toBe(0);
    store.put(row("late", "2026-09-28T12:05"));
    expect(vi.getTimerCount()).toBe(1);
    store.put(row("soon", "2026-09-28T12:02"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(dispatched).toEqual(["soon", "late"]);
    expect(vi.getTimerCount()).toBe(0);
    timer.stop();
  });

  it("stops arming once stopped", async () => {
    const dispatch = vi.fn(async () => {});
    const timer = startLocalDevScheduleTimer({ store, dispatch });
    store.put(row("a", "2026-09-28T12:01"));
    timer.stop();
    expect(vi.getTimerCount()).toBe(0);
    store.put(row("b", "2026-09-28T12:02"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
