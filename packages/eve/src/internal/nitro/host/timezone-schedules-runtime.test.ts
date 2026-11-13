import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTimezoneSchedules } from "#internal/nitro/host/timezone-schedules-runtime.js";

const { runTask } = vi.hoisted(() => ({ runTask: vi.fn(async () => ({})) }));
vi.mock("nitro/task", () => ({ runTask }));

const closers: (() => void)[] = [];
function install(cron: string, timezone = "America/Los_Angeles", ready = Promise.resolve()) {
  installTimezoneSchedules(
    {
      ready,
      hooks: {
        hook: (_name, close) => {
          closers.push(close);
        },
      },
    },
    [{ cron, timezone, nitroTaskName: "eve.digest" }],
  );
}

beforeEach(() => {
  vi.stubEnv("TEST", "");
});

afterEach(() => {
  for (const close of closers.splice(0)) close();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("self-hosted timezone schedules", () => {
  it("stays idle under TEST, like Nitro's schedule runner", async () => {
    vi.stubEnv("TEST", "true");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T20:59:59Z"));
    install("0 13 * * *");
    await vi.advanceTimersByTimeAsync(2000);
    expect(runTask).not.toHaveBeenCalled();
    expect(closers).toEqual([]);
  });

  it.each([
    ["2026-01-15T20:59:59Z", "2026-01-15T21:00:00Z"],
    ["2026-07-15T19:59:59Z", "2026-07-15T20:00:00Z"],
  ])("runs at 13:00 Pacific starting from %s", async (start, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(start));
    install("0 13 * * *");
    await vi.advanceTimersByTimeAsync(999);
    expect(runTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runTask).toHaveBeenCalledExactlyOnceWith("eve.digest", {
      payload: { scheduledTime: Date.parse(expected) },
    });
    closers[0]!();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["2026-03-08T09:59:59Z", "30 2 * * *", "2026-03-08T10:00:00Z"],
    ["2026-11-01T08:29:59Z", "30 1 * * *", "2026-11-01T08:30:00Z"],
  ])(
    "runs a fixed daily time once through the DST transition at %s",
    async (start, cron, expected) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(start));
      install(cron);
      await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
      expect(runTask).toHaveBeenCalledExactlyOnceWith("eve.digest", {
        payload: { scheduledTime: Date.parse(expected) },
      });
    },
  );

  it("waits for the host to be ready and cancels pending dispatch when it closes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T20:59:59Z"));
    let resolveReady!: () => void;
    install(
      "0 13 * * *",
      "America/Los_Angeles",
      new Promise<void>((resolve) => {
        resolveReady = resolve;
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(runTask).not.toHaveBeenCalled();
    closers[0]!();
    resolveReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(runTask).not.toHaveBeenCalled();
  });
});
