import { mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { pruneLocalTraceStore } from "#harness/local-trace-retention.js";
import {
  resolveLocalTraceSchemaDirectory,
  resolveLocalTraceSegmentsDirectory,
} from "#harness/local-trace-span-processor.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

/**
 * Writes one trace whose segments directory carries `modifiedAtMs`, which is
 * what the policy reads as "when this trace last received a span".
 */
async function writeTrace(input: {
  readonly appRoot: string;
  readonly modifiedAtMs: number;
  readonly segmentBytes?: number;
  readonly traceId: string;
}): Promise<void> {
  const segments = resolveLocalTraceSegmentsDirectory(input.appRoot, input.traceId);
  await mkdir(segments, { recursive: true });
  await writeFile(
    join(segments, "aaaaaaaaaaaaaaaa.otlp.json"),
    "x".repeat(input.segmentBytes ?? 8),
  );
  const modifiedAt = new Date(input.modifiedAtMs);
  await utimes(segments, modifiedAt, modifiedAt);
}

async function listTraceIds(appRoot: string): Promise<string[]> {
  return (await readdir(resolveLocalTraceSchemaDirectory(appRoot))).sort();
}

describe("pruneLocalTraceStore", () => {
  it("treats a missing store as a no-op", async () => {
    const appRoot = await createScratchDirectory("eve-trace-retention-missing-");

    await expect(
      pruneLocalTraceStore({ activeTraceIds: new Set(), appRoot, now: NOW }),
    ).resolves.toMatchObject({ reclaimedBytes: 0, removedTraces: 0 });
  });

  it("evicts traces past the age bound", async () => {
    const appRoot = await createScratchDirectory("eve-trace-retention-age-");
    await writeTrace({ appRoot, modifiedAtMs: NOW - 30 * DAY_MS, traceId: "old" });
    await writeTrace({ appRoot, modifiedAtMs: NOW - 1 * DAY_MS, traceId: "recent" });

    const result = await pruneLocalTraceStore({
      activeTraceIds: new Set(),
      appRoot,
      maxAgeMs: 7 * DAY_MS,
      now: NOW,
      retainCount: 1,
    });

    expect(result.removedTraces).toBe(1);
    expect(result.reasons).toContain("maxAgeMs");
    await expect(listTraceIds(appRoot)).resolves.toEqual(["recent"]);
  });

  it("keeps the newest traces even when every one is past the age bound", async () => {
    const appRoot = await createScratchDirectory("eve-trace-retention-floor-");
    for (const index of [0, 1, 2, 3]) {
      await writeTrace({
        appRoot,
        modifiedAtMs: NOW - (30 + index) * DAY_MS,
        traceId: `trace-${index}`,
      });
    }

    await pruneLocalTraceStore({
      activeTraceIds: new Set(),
      appRoot,
      maxAgeMs: 7 * DAY_MS,
      now: NOW,
      retainCount: 2,
    });

    await expect(listTraceIds(appRoot)).resolves.toEqual(["trace-0", "trace-1"]);
  });

  it("evicts oldest-first under the size budget without breaching the floor", async () => {
    const appRoot = await createScratchDirectory("eve-trace-retention-size-");
    for (const index of [0, 1, 2, 3]) {
      await writeTrace({
        appRoot,
        modifiedAtMs: NOW - HOUR_MS - index * 1_000,
        segmentBytes: 1_000,
        traceId: `trace-${index}`,
      });
    }

    const result = await pruneLocalTraceStore({
      activeTraceIds: new Set(),
      appRoot,
      maxAgeMs: false,
      maxTotalBytes: 1_500,
      now: NOW,
      retainCount: 2,
    });

    expect(result.reasons).toContain("maxTotalBytes");
    // The budget wants one trace; the floor guarantees two.
    await expect(listTraceIds(appRoot)).resolves.toEqual(["trace-0", "trace-1"]);
  });

  it("never evicts a trace whose session is still open", async () => {
    const appRoot = await createScratchDirectory("eve-trace-retention-active-");
    await writeTrace({ appRoot, modifiedAtMs: NOW - 90 * DAY_MS, traceId: "live" });
    await writeTrace({ appRoot, modifiedAtMs: NOW - 91 * DAY_MS, traceId: "finished" });

    await pruneLocalTraceStore({
      activeTraceIds: new Set(["live"]),
      appRoot,
      maxAgeMs: 0,
      maxTotalBytes: 0,
      now: NOW,
      retainCount: 0,
    });

    await expect(listTraceIds(appRoot)).resolves.toEqual(["live"]);
  });

  it("reaps temp files abandoned by a killed writer", async () => {
    const appRoot = await createScratchDirectory("eve-trace-retention-tmp-");
    await writeTrace({ appRoot, modifiedAtMs: NOW, traceId: "current" });
    const segments = resolveLocalTraceSegmentsDirectory(appRoot, "current");
    const abandoned = join(segments, "bbbbbbbbbbbbbbbb.otlp.json.tmp-123-abc");
    await writeFile(abandoned, "orphan");
    const staleAt = new Date(NOW - 60 * 60 * 1_000);
    await utimes(abandoned, staleAt, staleAt);

    await pruneLocalTraceStore({ activeTraceIds: new Set(), appRoot, now: NOW });

    await expect(readdir(segments)).resolves.toEqual(["aaaaaaaaaaaaaaaa.otlp.json"]);
  });

  it("leaves a temp file alone while its atomic write is still in flight", async () => {
    const appRoot = await createScratchDirectory("eve-trace-retention-tmp-live-");
    await writeTrace({ appRoot, modifiedAtMs: NOW, traceId: "current" });
    const segments = resolveLocalTraceSegmentsDirectory(appRoot, "current");
    const inFlight = join(segments, "cccccccccccccccc.otlp.json.tmp-123-abc");
    await writeFile(inFlight, "half-written");
    const justNow = new Date(NOW);
    await utimes(inFlight, justNow, justNow);

    await pruneLocalTraceStore({ activeTraceIds: new Set(["current"]), appRoot, now: NOW });

    await expect(stat(inFlight)).resolves.toBeDefined();
  });

  it("bounds a trace directory that never grew a segments directory", async () => {
    const appRoot = await createScratchDirectory("eve-trace-retention-partial-");
    const partial = join(resolveLocalTraceSchemaDirectory(appRoot), "partial");
    await mkdir(partial, { recursive: true });
    const staleAt = new Date(NOW - 30 * DAY_MS);
    await utimes(partial, staleAt, staleAt);

    await pruneLocalTraceStore({
      activeTraceIds: new Set(),
      appRoot,
      maxAgeMs: 7 * DAY_MS,
      now: NOW,
      retainCount: 0,
    });

    await expect(stat(partial)).rejects.toThrow();
  });

  it("keeps sweeping when stray files sit where directories are expected", async () => {
    const appRoot = await createScratchDirectory("eve-trace-retention-stray-");
    await writeTrace({ appRoot, modifiedAtMs: NOW - 30 * DAY_MS, traceId: "old" });
    // Finder leaves these behind in any browsed directory, and a sweep that
    // throws on one would stop bounding the store forever.
    await writeFile(join(resolveLocalTraceSchemaDirectory(appRoot), ".DS_Store"), "junk");
    const occupied = join(resolveLocalTraceSchemaDirectory(appRoot), "occupied");
    await mkdir(occupied, { recursive: true });
    const strayPath = join(occupied, "segments");
    await writeFile(strayPath, "not a directory");
    const staleAt = new Date(NOW - 30 * DAY_MS);
    await utimes(strayPath, staleAt, staleAt);
    await utimes(occupied, staleAt, staleAt);

    const result = await pruneLocalTraceStore({
      activeTraceIds: new Set(),
      appRoot,
      maxAgeMs: 7 * DAY_MS,
      now: NOW,
      retainCount: 0,
    });

    // Both aged-out entries go, and the stray file is simply not a trace.
    expect(result.removedTraces).toBe(2);
    await expect(listTraceIds(appRoot)).resolves.toEqual([".DS_Store"]);
  });

  it("never evicts a trace written inside the quiescence window", async () => {
    const appRoot = await createScratchDirectory("eve-trace-retention-quiescent-");
    // Another dev worker could still be writing this one: liveness is tracked
    // per process, so recency is the only cross-process signal.
    await writeTrace({ appRoot, modifiedAtMs: NOW - 1_000, traceId: "draining" });
    await writeTrace({ appRoot, modifiedAtMs: NOW - HOUR_MS, traceId: "settled" });

    await pruneLocalTraceStore({
      activeTraceIds: new Set(),
      appRoot,
      maxAgeMs: 0,
      maxTotalBytes: 0,
      now: NOW,
      retainCount: 0,
    });

    await expect(listTraceIds(appRoot)).resolves.toEqual(["draining"]);
  });

  it("counts temp files left behind toward the size budget", async () => {
    const appRoot = await createScratchDirectory("eve-trace-retention-tmp-budget-");
    await writeTrace({
      appRoot,
      modifiedAtMs: NOW - HOUR_MS,
      segmentBytes: 10,
      traceId: "bloated",
    });
    const segments = resolveLocalTraceSegmentsDirectory(appRoot, "bloated");
    // Recent enough to survive reaping, so its bytes must still be counted.
    await writeFile(join(segments, "dddddddddddddddd.otlp.json.tmp-1-a"), "x".repeat(5_000));
    // Writing into the directory bumped its mtime; restore the settled age.
    const settledAt = new Date(NOW - HOUR_MS);
    await utimes(segments, settledAt, settledAt);

    const result = await pruneLocalTraceStore({
      activeTraceIds: new Set(),
      appRoot,
      maxAgeMs: false,
      maxTotalBytes: 1_000,
      now: NOW,
      retainCount: 0,
    });

    expect(result.reasons).toEqual(["maxTotalBytes"]);
    expect(result.reclaimedBytes).toBeGreaterThan(5_000);
    await expect(listTraceIds(appRoot)).resolves.toEqual([]);
  });
});
