import { EventEmitter } from "node:events";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { startEmbeddedNitroViteDevWatcher } from "#internal/nitro/host/embedded-nitro-vite-dev-watcher.js";

class FakeWatcher extends EventEmitter {
  readonly add = vi.fn();
  readonly unwatch = vi.fn();
}

async function flushTimers(): Promise<void> {
  await vi.runAllTimersAsync();
  await Promise.resolve();
}

describe("startEmbeddedNitroViteDevWatcher", () => {
  it("rebuilds authored changes but ignores unrelated host files", async () => {
    vi.useFakeTimers();
    const watcher = new FakeWatcher();
    const rebuild = vi.fn(async () => {});
    const handle = await startEmbeddedNitroViteDevWatcher({
      debounceMs: 1,
      rebuild,
      watchPaths: ["/app/agent", "/app/package.json"],
      watcher,
    });

    watcher.emit("all", "change", resolve("/app/src/page.tsx"));
    await flushTimers();
    expect(rebuild).not.toHaveBeenCalled();

    watcher.emit("all", "change", resolve("/app/agent/instructions.md"));
    await flushTimers();
    expect(rebuild).toHaveBeenCalledWith([resolve("/app/agent/instructions.md")]);
    expect(watcher.add).toHaveBeenCalledWith(["/app/agent", "/app/package.json"]);

    await handle.close();
    vi.useRealTimers();
  });

  it("coalesces rapid changes and converges on a change received during rebuild", async () => {
    vi.useFakeTimers();
    const watcher = new FakeWatcher();
    let releaseFirstRebuild: (() => void) | undefined;
    const rebuild = vi
      .fn<(changedPaths: readonly string[]) => Promise<void>>()
      .mockImplementationOnce(
        async () =>
          await new Promise<void>((resolveRebuild) => {
            releaseFirstRebuild = resolveRebuild;
          }),
      )
      .mockResolvedValue(undefined);
    const handle = await startEmbeddedNitroViteDevWatcher({
      debounceMs: 1,
      rebuild,
      watchPaths: ["/app/agent"],
      watcher,
    });

    watcher.emit("all", "change", "/app/agent/a.ts");
    watcher.emit("all", "change", "/app/agent/b.ts");
    await vi.advanceTimersByTimeAsync(1);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenNthCalledWith(1, [
      resolve("/app/agent/a.ts"),
      resolve("/app/agent/b.ts"),
    ]);

    watcher.emit("all", "change", "/app/agent/c.ts");
    releaseFirstRebuild?.();
    await flushTimers();
    expect(rebuild).toHaveBeenNthCalledWith(2, [resolve("/app/agent/c.ts")]);

    await handle.close();
    vi.useRealTimers();
  });

  it("removes its listener and pending timer on close", async () => {
    vi.useFakeTimers();
    const watcher = new FakeWatcher();
    const rebuild = vi.fn(async () => {});
    const handle = await startEmbeddedNitroViteDevWatcher({
      debounceMs: 1,
      rebuild,
      watchPaths: ["/app/agent"],
      watcher,
    });

    watcher.emit("all", "change", "/app/agent/a.ts");
    await handle.close();
    await flushTimers();

    expect(rebuild).not.toHaveBeenCalled();
    expect(watcher.listenerCount("all")).toBe(0);
    vi.useRealTimers();
  });

  it("awaits an active rebuild before close completes and ignores later mutations", async () => {
    vi.useFakeTimers();
    const watcher = new FakeWatcher();
    let releaseRebuild: (() => void) | undefined;
    let closeCompleted = false;
    const mutation = vi.fn(() => {
      expect(closeCompleted).toBe(false);
    });
    const rebuild = vi.fn(async () => {
      await new Promise<void>((resolveRebuild) => {
        releaseRebuild = resolveRebuild;
      });
      mutation();
    });
    const handle = await startEmbeddedNitroViteDevWatcher({
      debounceMs: 1,
      rebuild,
      watchPaths: ["/app/agent"],
      watcher,
    });

    watcher.emit("all", "change", "/app/agent/a.ts");
    await vi.advanceTimersByTimeAsync(1);

    const close = handle.close().then(() => {
      closeCompleted = true;
    });
    handle.updateWatchPaths(["/replacement"]);
    watcher.emit("all", "change", "/app/agent/b.ts");
    await Promise.resolve();

    expect(closeCompleted).toBe(false);
    expect(watcher.listenerCount("all")).toBe(0);
    expect(watcher.add).toHaveBeenCalledOnce();
    expect(watcher.unwatch).not.toHaveBeenCalled();

    releaseRebuild?.();
    await close;
    await flushTimers();

    expect(mutation).toHaveBeenCalledOnce();
    expect(rebuild).toHaveBeenCalledOnce();
    expect(closeCompleted).toBe(true);
    vi.useRealTimers();
  });

  it("can stop an active restart-triggering watcher without waiting on itself", async () => {
    vi.useFakeTimers();
    const watcher = new FakeWatcher();
    let releaseRebuild: (() => void) | undefined;
    const rebuild = vi.fn(
      async () =>
        await new Promise<void>((resolveRebuild) => {
          releaseRebuild = resolveRebuild;
        }),
    );
    const handle = await startEmbeddedNitroViteDevWatcher({
      debounceMs: 1,
      rebuild,
      watchPaths: ["/app/agent"],
      watcher,
    });

    watcher.emit("all", "change", "/app/agent/a.ts");
    await vi.advanceTimersByTimeAsync(1);

    handle.stop();
    watcher.emit("all", "change", "/app/agent/b.ts");

    expect(watcher.listenerCount("all")).toBe(0);
    expect(rebuild).toHaveBeenCalledOnce();

    releaseRebuild?.();
    await handle.close();
    await flushTimers();

    expect(rebuild).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("updates matcher roots and changes only the underlying watcher delta", async () => {
    vi.useFakeTimers();
    const watcher = new FakeWatcher();
    const rebuild = vi.fn(async () => {});
    const handle = await startEmbeddedNitroViteDevWatcher({
      debounceMs: 1,
      rebuild,
      watchPaths: ["/app/agent"],
      watcher,
    });

    handle.updateWatchPaths(["/app/agent", "/extension/src"]);
    expect(watcher.add).toHaveBeenLastCalledWith(["/extension/src"]);
    watcher.emit("all", "add", "/extension/src/index.ts");
    await flushTimers();
    expect(rebuild).toHaveBeenLastCalledWith([resolve("/extension/src/index.ts")]);

    handle.updateWatchPaths(["/extension/src"]);
    expect(watcher.unwatch).toHaveBeenCalledWith(["/app/agent"]);
    watcher.emit("all", "change", "/app/agent/ignored.ts");
    await flushTimers();
    expect(rebuild).toHaveBeenCalledOnce();

    await handle.close();
    vi.useRealTimers();
  });
});
