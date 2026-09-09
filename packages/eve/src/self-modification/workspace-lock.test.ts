import { describe, expect, it } from "vitest";

import { withSelfModificationWorkspaceLock } from "./workspace-lock.js";

describe("self-modification workspace lock", () => {
  it("serializes operations for the same workspace", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withSelfModificationWorkspaceLock("sandbox-1", async () => {
      events.push("first:start");
      await firstBlocked;
      events.push("first:end");
    });
    const second = withSelfModificationWorkspaceLock("sandbox-1", async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("allows operations for different workspaces to overlap", async () => {
    const started: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withSelfModificationWorkspaceLock("sandbox-1", async () => {
      started.push("sandbox-1");
      await blocked;
    });
    const second = withSelfModificationWorkspaceLock("sandbox-2", async () => {
      started.push("sandbox-2");
    });

    await second;
    expect(started).toEqual(["sandbox-1", "sandbox-2"]);
    release();
    await first;
  });

  it("releases the workspace after an operation fails", async () => {
    await expect(
      withSelfModificationWorkspaceLock("sandbox-1", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");

    await expect(
      withSelfModificationWorkspaceLock("sandbox-1", async () => "recovered"),
    ).resolves.toBe("recovered");
  });
});
