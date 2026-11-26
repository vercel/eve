import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLocalDevScheduleStore,
  nextFireAtMs,
  type LocalDevScheduleRow,
  type LocalDevScheduleStore,
} from "#internal/schedules/local-dev-store.js";

const directories: string[] = [];
const stores: LocalDevScheduleStore[] = [];

function dbPath() {
  const directory = mkdtempSync(join(tmpdir(), "eve-local-dev-store-"));
  directories.push(directory);
  return join(directory, ".eve", "schedules.db");
}

function open(path: string, now: () => number = Date.now) {
  const store = createLocalDevScheduleStore({ dbPath: path, now });
  stores.push(store);
  return store;
}

function row(overrides: Partial<LocalDevScheduleRow> = {}): LocalDevScheduleRow {
  return {
    collection: "wake",
    namespace: "ns",
    name: "once",
    scheduleId: "local_1",
    state: "active",
    expression: { type: "single", at: "2026-09-28T12:01", timezone: "UTC" },
    payload: { note: "hi" },
    nextFireAtMs: Date.parse("2026-09-28T12:01:00.000Z"),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("nextFireAtMs", () => {
  it("reads one-time schedules in their timezone and never fires them again once past", () => {
    const before = Date.parse("2026-09-28T12:00:00.000Z");
    const expected = Date.parse("2026-09-28T12:01:00.000Z");
    expect(nextFireAtMs({ type: "single", at: "2026-09-28T12:01" }, before)).toBe(expected);
    expect(
      nextFireAtMs({ type: "single", at: "2026-09-28T14:01", timezone: "Europe/Berlin" }, before),
    ).toBe(expected);
    expect(nextFireAtMs({ type: "single", at: "2026-09-28T12:01" }, expected)).toBeNull();
  });

  it("advances cron expressions strictly past the given time in their timezone", () => {
    const at = Date.parse("2026-09-28T12:00:00.000Z");
    expect(nextFireAtMs({ type: "cron", cron: "* * * * *" }, at)).toBe(at + 60_000);
    expect(
      nextFireAtMs({ type: "cron", cron: "0 9 * * *", timezone: "America/New_York" }, at),
    ).toBe(Date.parse("2026-09-28T13:00:00.000Z"));
  });
});

describe("local dev schedule store", () => {
  it("keeps schedules across reopening the database", () => {
    const path = dbPath();
    const first = open(path);
    first.put(row());
    first.close();
    const second = open(path);
    expect(second.get("wake", "ns", "once")).toEqual(row());
    expect(second.list("wake", "ns")).toHaveLength(1);
    expect(second.list("wake", "other")).toHaveLength(0);
    expect(second.earliestFireAtMs()).toBe(row().nextFireAtMs);
  });

  it("claims a due one-time schedule once, even across a restart", () => {
    const path = dbPath();
    const due = row().nextFireAtMs!;
    const first = open(path);
    first.put(row());
    expect(first.claimDue(due - 1)).toEqual([]);
    expect(first.claimDue(due)).toEqual([{ row: row(), scheduledAtMs: due }]);
    expect(first.claimDue(due + 60_000)).toEqual([]);
    first.close();
    const second = open(path);
    expect(second.claimDue(due + 120_000)).toEqual([]);
    expect(second.get("wake", "ns", "once")).toMatchObject({
      state: "completed",
      nextFireAtMs: null,
    });
    expect(second.earliestFireAtMs()).toBeNull();
  });

  it("fires a recurring schedule missed while stopped once, then moves to the next future minute", () => {
    const store = open(dbPath());
    const missed = Date.parse("2026-09-28T12:00:00.000Z");
    store.put(
      row({
        expression: { type: "cron", cron: "* * * * *" },
        nextFireAtMs: missed,
      }),
    );
    const restartedAt = missed + 5 * 60_000 + 10_000;
    expect(store.claimDue(restartedAt)).toHaveLength(1);
    expect(store.earliestFireAtMs()).toBe(missed + 6 * 60_000);
  });

  it("notifies listeners on writes and stops after unsubscribe", () => {
    const store = open(dbPath());
    let calls = 0;
    const unsubscribe = store.onChange(() => calls++);
    store.put(row());
    store.remove("wake", "ns", "once");
    expect(calls).toBe(2);
    unsubscribe();
    store.put(row());
    expect(calls).toBe(2);
  });

  it("replays the first result of an operation id", () => {
    const store = open(dbPath());
    let runs = 0;
    expect(store.operation("op", () => ++runs)).toBe(1);
    expect(store.operation("op", () => ++runs)).toBe(1);
    expect(runs).toBe(1);
  });
});
