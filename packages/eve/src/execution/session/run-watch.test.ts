import { afterEach, describe, expect, it, vi } from "vitest";

import { watchRunEnd } from "#execution/session/run-watch.js";

const sleeps: (() => void)[] = [];
const hasRunEndedStepMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  sleep: () => new Promise<void>((resolve) => sleeps.push(resolve)),
}));
vi.mock("#execution/session/handoff-steps.js", () => ({
  hasRunEndedStep: (...args: unknown[]) => hasRunEndedStepMock(...args),
}));

afterEach(() => {
  sleeps.length = 0;
  vi.resetAllMocks();
});

describe("watchRunEnd", () => {
  it("checks after each interval and resolves once the run has ended", async () => {
    hasRunEndedStepMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const watch = watchRunEnd("run-b");

    await vi.waitFor(() => expect(sleeps).toHaveLength(1));
    sleeps[0]!();
    await vi.waitFor(() => expect(sleeps).toHaveLength(2));
    sleeps[1]!();

    await expect(watch.ended).resolves.toBeUndefined();
    expect(hasRunEndedStepMock).toHaveBeenCalledTimes(2);
    expect(hasRunEndedStepMock).toHaveBeenCalledWith({ runId: "run-b" });
  });

  it("keeps watching after a status check fails", async () => {
    hasRunEndedStepMock
      .mockRejectedValueOnce(new Error("world unavailable"))
      .mockResolvedValueOnce(true);
    const watch = watchRunEnd("run-b");

    await vi.waitFor(() => expect(sleeps).toHaveLength(1));
    sleeps[0]!();
    await vi.waitFor(() => expect(sleeps).toHaveLength(2));
    sleeps[1]!();

    await expect(watch.ended).resolves.toBeUndefined();
    expect(hasRunEndedStepMock).toHaveBeenCalledTimes(2);
  });

  it("checks nothing more once stopped", async () => {
    const watch = watchRunEnd("run-b");
    await vi.waitFor(() => expect(sleeps).toHaveLength(1));

    watch.stop();
    sleeps[0]!();
    await Promise.resolve();

    expect(hasRunEndedStepMock).not.toHaveBeenCalled();
    expect(sleeps).toHaveLength(1);
  });
});
