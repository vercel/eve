import { describe, expect, it, onTestFinished, vi } from "vitest";

import { closeWorkflowWorld, installWorkflowWorld } from "#execution/install-workflow-world.js";

async function installWorld(close: () => Promise<void>, start?: () => Promise<void>) {
  await installWorkflowWorld({
    world: { close, createQueueHandler: () => undefined, events: {}, specVersion: 9, start },
  } as never);
}

function captureConsoleError() {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => error.mockRestore());
  return error;
}

describe("closeWorkflowWorld", () => {
  it("closes the installed World once, so its timers cannot keep a stopped server alive", async () => {
    const close = vi.fn(async () => {});
    const start = vi.fn(async () => {});
    await installWorld(close, start);

    await closeWorkflowWorld();
    await closeWorkflowWorld();

    expect(start).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  // Nitro runs `close` hooks in sequence; sandbox shutdown and the trace flush come after this one.
  it("logs a failed close instead of rejecting, so later Nitro close hooks still run", async () => {
    const error = captureConsoleError();
    await installWorld(async () => {
      throw new Error("pool already ended");
    });

    await expect(closeWorkflowWorld()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("pool already ended"));
  });

  it("stops waiting for a close that never settles, so later Nitro close hooks still run", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const error = captureConsoleError();
    await installWorld(() => new Promise<void>(() => {}));

    const closed = closeWorkflowWorld();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(closed).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  it("does nothing before a World is installed", async () => {
    await expect(closeWorkflowWorld()).resolves.toBeUndefined();
  });
});
