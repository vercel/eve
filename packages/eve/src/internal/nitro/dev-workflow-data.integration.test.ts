import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pruneWorkflowLocalData } from "./dev-workflow-data.js";

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.parse("2026-07-01T12:00:00.000Z");

const STALE_COMPLETED_RUN_ID = "wrun_01STALECOMPLETED";
const STALE_FAILED_RUN_ID = "wrun_01STALEFAILED";
const STALE_RUNNING_RUN_ID = "wrun_01STALERUNNING";
const FRESH_COMPLETED_RUN_ID = "wrun_01FRESHCOMPLETED";

let appRoot: string;

async function writeRun(runId: string, status: string, updatedAtMs: number): Promise<void> {
  const record = {
    createdAt: new Date(updatedAtMs).toISOString(),
    runId,
    status,
    updatedAt: new Date(updatedAtMs).toISOString(),
  };
  await writeFile(join(appRoot, ".workflow-data", "runs", `${runId}.json`), JSON.stringify(record));
}

async function writeRunLinkedFiles(runId: string): Promise<void> {
  const dataDirectory = join(appRoot, ".workflow-data");
  const ulid = runId.slice("wrun_".length);
  await writeFile(join(dataDirectory, "events", `${runId}-evnt_01E.json`), "{}");
  await writeFile(join(dataDirectory, "steps", `${runId}-step_01S.json`), "{}");
  await writeFile(join(dataDirectory, "hooks", `hook_${ulid}.json`), JSON.stringify({ runId }));
  await writeFile(join(dataDirectory, "streams", "runs", `${runId}.json`), "{}");
  await writeFile(join(dataDirectory, "streams", "chunks", `strm_${ulid}_user-chnk_01C.bin`), "x");
}

async function directoryNames(...segments: string[]): Promise<readonly string[]> {
  return readdir(join(appRoot, ".workflow-data", ...segments));
}

beforeEach(async () => {
  appRoot = await mkdtemp(join(tmpdir(), "eve-dev-workflow-data-"));
  for (const segments of [
    ["runs"],
    ["events"],
    ["steps"],
    ["hooks"],
    ["streams", "runs"],
    ["streams", "chunks"],
  ]) {
    await mkdir(join(appRoot, ".workflow-data", ...segments), { recursive: true });
  }
});

afterEach(async () => {
  await rm(appRoot, { force: true, recursive: true });
});

describe("pruneWorkflowLocalData", () => {
  it("deletes terminal runs older than the retention window with their linked files", async () => {
    const staleMs = NOW_MS - 100 * HOUR_MS;
    await writeRun(STALE_COMPLETED_RUN_ID, "completed", staleMs);
    await writeRun(STALE_FAILED_RUN_ID, "failed", staleMs);
    await writeRunLinkedFiles(STALE_COMPLETED_RUN_ID);
    await writeRunLinkedFiles(STALE_FAILED_RUN_ID);

    await pruneWorkflowLocalData({ appRoot, now: NOW_MS });

    expect(await directoryNames("runs")).toEqual([]);
    expect(await directoryNames("events")).toEqual([]);
    expect(await directoryNames("steps")).toEqual([]);
    expect(await directoryNames("hooks")).toEqual([]);
    expect(await directoryNames("streams", "runs")).toEqual([]);
    expect(await directoryNames("streams", "chunks")).toEqual([]);
  });

  it("never deletes non-terminal runs, whatever their age", async () => {
    await writeRun(STALE_RUNNING_RUN_ID, "running", NOW_MS - 1000 * HOUR_MS);
    await writeRunLinkedFiles(STALE_RUNNING_RUN_ID);

    await pruneWorkflowLocalData({ appRoot, now: NOW_MS });

    expect(await directoryNames("runs")).toEqual([`${STALE_RUNNING_RUN_ID}.json`]);
    expect(await directoryNames("events")).toHaveLength(1);
    expect(await directoryNames("hooks")).toHaveLength(1);
  });

  it("keeps terminal runs inside the retention window", async () => {
    await writeRun(FRESH_COMPLETED_RUN_ID, "completed", NOW_MS - HOUR_MS);
    await writeRunLinkedFiles(FRESH_COMPLETED_RUN_ID);

    await pruneWorkflowLocalData({ appRoot, now: NOW_MS });

    expect(await directoryNames("runs")).toEqual([`${FRESH_COMPLETED_RUN_ID}.json`]);
    expect(await directoryNames("streams", "chunks")).toHaveLength(1);
  });

  it("keeps linked files belonging to other runs when a stale run is deleted", async () => {
    const staleMs = NOW_MS - 100 * HOUR_MS;
    await writeRun(STALE_COMPLETED_RUN_ID, "completed", staleMs);
    await writeRunLinkedFiles(STALE_COMPLETED_RUN_ID);
    await writeRun(FRESH_COMPLETED_RUN_ID, "completed", NOW_MS - HOUR_MS);
    await writeRunLinkedFiles(FRESH_COMPLETED_RUN_ID);

    await pruneWorkflowLocalData({ appRoot, now: NOW_MS });

    expect(await directoryNames("runs")).toEqual([`${FRESH_COMPLETED_RUN_ID}.json`]);
    expect(await directoryNames("events")).toEqual([`${FRESH_COMPLETED_RUN_ID}-evnt_01E.json`]);
    expect(await directoryNames("steps")).toEqual([`${FRESH_COMPLETED_RUN_ID}-step_01S.json`]);
    expect(await directoryNames("streams", "runs")).toEqual([`${FRESH_COMPLETED_RUN_ID}.json`]);
  });

  it("ignores unreadable run records and unrelated files", async () => {
    await writeFile(join(appRoot, ".workflow-data", "runs", "wrun_01BROKEN.json"), "not json");
    await writeFile(join(appRoot, ".workflow-data", "runs", "notes.txt"), "keep");
    await writeRun(STALE_COMPLETED_RUN_ID, "completed", NOW_MS - 100 * HOUR_MS);

    await pruneWorkflowLocalData({ appRoot, now: NOW_MS });

    expect([...(await directoryNames("runs"))].sort()).toEqual(["notes.txt", "wrun_01BROKEN.json"]);
  });

  it("is a no-op when the store does not exist", async () => {
    await rm(join(appRoot, ".workflow-data"), { force: true, recursive: true });

    await expect(pruneWorkflowLocalData({ appRoot, now: NOW_MS })).resolves.toBeUndefined();
  });
});
