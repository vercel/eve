import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BrowserBenchmarkLiveStatus,
  readBrowserBenchmarkLiveStatus,
  updateBrowserBenchmarkLiveStatus,
  writeBrowserBenchmarkLiveStatus,
} from "../live-status";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true }))
  );
});

describe("browser benchmark live status", () => {
  it("publishes atomic updates only for the active run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-bench-status-"));
    directories.push(directory);
    const path = join(directory, "live.json");
    const status = exampleStatus();

    await writeBrowserBenchmarkLiveStatus(path, status);
    await updateBrowserBenchmarkLiveStatus(path, "stale-run", (current) => ({
      ...current,
      status: "failed",
    }));
    expect((await readBrowserBenchmarkLiveStatus(path))?.status).toBe(
      "preparing"
    );

    await updateBrowserBenchmarkLiveStatus(path, status.runId, (current) => ({
      ...current,
      status: "running",
    }));
    expect((await readBrowserBenchmarkLiveStatus(path))?.status).toBe(
      "running"
    );
  });
});

function variant(kind: "baseline" | "candidate") {
  return {
    completedAt: null,
    error: null,
    kind,
    ref: "main",
    sha: "a".repeat(40),
    startedAt: null,
    status: "pending" as const,
    tasks: [],
    url: `https://${kind}.localhost`,
  };
}

function exampleStatus(): BrowserBenchmarkLiveStatus {
  const now = new Date().toISOString();
  return {
    completedAt: null,
    error: null,
    maxConcurrency: 2,
    outputDirectory: "/tmp/browser-ab",
    repetitions: 1,
    runId: "active-run",
    startedAt: now,
    status: "preparing",
    suite: "smoke",
    taskTimeoutMs: 900_000,
    updatedAt: now,
    variants: {
      baseline: variant("baseline"),
      candidate: variant("candidate"),
    },
    version: 1,
  };
}
