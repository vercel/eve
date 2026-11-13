import { describe, expect, it, vi } from "vitest";

import { BrowserCancellationError, runWithCancellation } from "../../agent/lib/cancellation";

describe("browser operation cancellation", () => {
  it("does not start queued work after cancellation cleanup", async () => {
    const controller = new AbortController(), operation = vi.fn(), cleanup = vi.fn(async () => undefined);
    const pending = runWithCancellation(controller.signal, operation, cleanup);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(BrowserCancellationError);
    expect(operation).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("never starts work for a previously aborted turn", async () => {
    const controller = new AbortController(), operation = vi.fn(), cleanup = vi.fn(async () => undefined);
    controller.abort();
    await expect(runWithCancellation(controller.signal, operation, cleanup)).rejects.toBeInstanceOf(BrowserCancellationError);
    expect(operation).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it("waits for browser cleanup and rejects as canceled", async () => {
    const controller = new AbortController();
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanup = vi.fn(() => cleanupGate);
    const work = runWithCancellation(
      controller.signal,
      () => new Promise<string>(() => undefined),
      cleanup,
    );

    controller.abort();
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledOnce();
    releaseCleanup();
    await expect(work).rejects.toBeInstanceOf(BrowserCancellationError);
  });

  it("runs cleanup only once for one abort signal", async () => {
    const controller = new AbortController();
    const cleanup = vi.fn(async () => undefined);
    const work = runWithCancellation(
      controller.signal,
      () => new Promise<string>(() => undefined),
      cleanup,
    );

    controller.abort();
    controller.abort();
    await expect(work).rejects.toBeInstanceOf(BrowserCancellationError);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("does not close a browser after completed work", async () => {
    const cleanup = vi.fn(async () => undefined);
    await expect(
      runWithCancellation(new AbortController().signal, async () => "done", cleanup),
    ).resolves.toBe("done");
    expect(cleanup).not.toHaveBeenCalled();
  });
});
