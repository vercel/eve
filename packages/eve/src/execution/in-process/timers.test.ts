import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInProcessTimeoutControl, createInProcessTimers } from "./timers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("in-process timers", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits to an absolute deadline past what one setTimeout allows", async () => {
    const timers = createInProcessTimers();
    let due = false;
    void timers.until(30 * DAY_MS).then(() => (due = true));
    await vi.advanceTimersByTimeAsync(25 * DAY_MS);
    expect(due).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * DAY_MS);
    expect(due).toBe(true);
  });

  it("never resolves a wait once disposed", async () => {
    const timers = createInProcessTimers();
    let due = false;
    void timers.until(1_000).then(() => (due = true));
    timers.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(due).toBe(false);
  });
});

describe("an in-process session timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("signals at its deadline, and extends to the deadline activity moved", async () => {
    const timers = createInProcessTimers();
    const signal = vi.fn();
    const timeout = createInProcessTimeoutControl({
      sessionId: "session_a",
      signal,
      timeoutMs: 1_000,
      timers,
    })!;
    await timeout.start();
    await vi.advanceTimersByTimeAsync(600);
    timeout.recordActivity();
    await vi.advanceTimersByTimeAsync(400);
    // The timer armed for the first deadline fires; the session was active since.
    expect(signal).toHaveBeenCalledTimes(1);
    await expect(timeout.handleTimerElapsed()).resolves.toBe("extended");
    await vi.advanceTimersByTimeAsync(600);
    expect(signal).toHaveBeenCalledTimes(2);
    await expect(timeout.handleTimerElapsed()).resolves.toBe("expired");
  });

  it("keeps a deadline it was restored with", async () => {
    const timeout = createInProcessTimeoutControl({
      deadline: new Date(250),
      sessionId: "session_a",
      signal: () => {},
      timeoutMs: 1_000,
      timers: createInProcessTimers(),
    })!;
    expect(timeout.getDeadline().getTime()).toBe(250);
    await vi.advanceTimersByTimeAsync(250);
    await expect(timeout.handleTimerElapsed()).resolves.toBe("expired");
  });

  it("is none for a session without a timeout", () => {
    expect(
      createInProcessTimeoutControl({
        sessionId: "session_a",
        signal: () => {},
        timeoutMs: false,
        timers: createInProcessTimers(),
      }),
    ).toBeUndefined();
  });
});
