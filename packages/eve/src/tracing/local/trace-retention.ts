import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  resolveLocalTraceSchemaDirectory,
  resolveLocalTraceSegmentsDirectory,
} from "#tracing/local/trace-span-processor.js";
import { createLogger, formatError } from "#internal/logging.js";

const log = createLogger("harness.local-trace-retention");

const LOCAL_TRACE_QUIESCENCE_MS = 5 * 60 * 1_000;

const LOCAL_TRACE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const LOCAL_TRACE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const LOCAL_TRACE_RETAIN_COUNT = 20;

type RetentionBound = number | false;

interface LocalTraceRetentionSettings {
  readonly enabled: boolean;
  readonly maxAgeMs: RetentionBound;
  readonly maxTotalBytes: RetentionBound;
  readonly retainCount: RetentionBound;
}

type LocalTracePruneReason = "maxAgeMs" | "maxTotalBytes";

interface LocalTracePruneResult {
  readonly reasons: readonly LocalTracePruneReason[];
  readonly reclaimedBytes: number;
  readonly removedTraces: number;
  readonly retainedTraces: number;
}

interface PruneLocalTraceStoreInput {
  readonly appRoot: string;
  readonly activeTraceIds: ReadonlySet<string>;
  readonly maxAgeMs?: RetentionBound;
  readonly maxTotalBytes?: RetentionBound;
  readonly now?: number;
  readonly retainCount?: RetentionBound;
}

interface StoredTrace {
  readonly byteSize: number;
  readonly modifiedAtMs: number;
  readonly path: string;
  readonly traceId: string;
}

export function resolveLocalTraceRetentionSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LocalTraceRetentionSettings {
  return {
    enabled: !isDisabled(env.EVE_TRACES),
    maxAgeMs: readBound(env, "EVE_TRACES_MAX_AGE_MS", LOCAL_TRACE_MAX_AGE_MS),
    maxTotalBytes: readBound(env, "EVE_TRACES_MAX_TOTAL_BYTES", LOCAL_TRACE_MAX_TOTAL_BYTES),
    retainCount: readBound(env, "EVE_TRACES_RETAIN_COUNT", LOCAL_TRACE_RETAIN_COUNT),
  };
}

export async function pruneLocalTraceStore(
  input: PruneLocalTraceStoreInput,
): Promise<LocalTracePruneResult> {
  const now = input.now ?? Date.now();
  const maxAgeMs = clampBound(input.maxAgeMs ?? LOCAL_TRACE_MAX_AGE_MS);
  const maxTotalBytes = clampBound(input.maxTotalBytes ?? LOCAL_TRACE_MAX_TOTAL_BYTES);
  const retainCount = clampCount(input.retainCount ?? LOCAL_TRACE_RETAIN_COUNT);

  const traces = await readStoredTraces(input.appRoot, now);
  const newestFirst = [...traces].sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  const floor = new Set(newestFirst.slice(0, retainCount === false ? 0 : retainCount));

  const reasons = new Set<LocalTracePruneReason>();
  let totalBytes = traces.reduce((sum, trace) => sum + trace.byteSize, 0);
  let reclaimedBytes = 0;
  let removedTraces = 0;
  let retainedTraces = 0;

  for (const trace of newestFirst.toReversed()) {
    const idle = now - trace.modifiedAtMs;
    const protectedTrace =
      input.activeTraceIds.has(trace.traceId) ||
      floor.has(trace) ||
      idle <= LOCAL_TRACE_QUIESCENCE_MS;
    const reason: LocalTracePruneReason | undefined = protectedTrace
      ? undefined
      : maxAgeMs !== false && idle > maxAgeMs
        ? "maxAgeMs"
        : maxTotalBytes !== false && totalBytes > maxTotalBytes
          ? "maxTotalBytes"
          : undefined;

    if (reason === undefined) {
      retainedTraces += 1;
      continue;
    }
    await rm(trace.path, { force: true, recursive: true });
    totalBytes -= trace.byteSize;
    reclaimedBytes += trace.byteSize;
    removedTraces += 1;
    reasons.add(reason);
  }

  return { reasons: [...reasons], reclaimedBytes, removedTraces, retainedTraces };
}

interface PruneRequestState {
  input: PruneLocalTraceStoreInput;
  requested: boolean;
  running: Promise<void> | undefined;
}

const pruneRequest: PruneRequestState = {
  input: { activeTraceIds: new Set(), appRoot: "" },
  requested: false,
  running: undefined,
};

export function requestLocalTraceStorePrune(input: PruneLocalTraceStoreInput): void {
  pruneRequest.input = input;
  pruneRequest.requested = true;
  if (pruneRequest.running === undefined) startPruning();
}

function startPruning(): void {
  pruneRequest.running = (async () => {
    while (pruneRequest.requested) {
      pruneRequest.requested = false;
      report(await pruneLocalTraceStore(pruneRequest.input));
    }
  })()
    .catch((error: unknown) => {
      log.warn("local trace retention failed", { error: formatError(error) });
    })
    .finally(() => {
      pruneRequest.running = undefined;
      if (pruneRequest.requested) startPruning();
    });
}

function report(result: LocalTracePruneResult): void {
  if (result.removedTraces === 0) return;
  log.info("pruned local traces", {
    reasons: result.reasons.join(","),
    reclaimedBytes: result.reclaimedBytes,
    removedTraces: result.removedTraces,
    retainedTraces: result.retainedTraces,
  });
}

async function readStoredTraces(appRoot: string, now: number): Promise<StoredTrace[]> {
  const schemaDirectory = resolveLocalTraceSchemaDirectory(appRoot);
  const entries = await readDirectoryEntries(schemaDirectory);
  if (entries === undefined) return [];

  const traces = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(schemaDirectory, entry.name);
        const segments = resolveLocalTraceSegmentsDirectory(appRoot, entry.name);
        await reapAbandonedTemporaryFiles(segments, now);
        const modifiedAtMs = (await directoryMtime(segments)) ?? (await directoryMtime(path));
        if (modifiedAtMs === undefined) return undefined;
        return {
          byteSize: await directorySize(path),
          modifiedAtMs,
          path,
          traceId: entry.name,
        };
      }),
  );
  return traces.filter((trace): trace is StoredTrace => trace !== undefined);
}

async function reapAbandonedTemporaryFiles(segmentsDirectory: string, now: number): Promise<void> {
  const entries = await readDirectoryEntries(segmentsDirectory);
  if (entries === undefined) return;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.includes(".tmp-")) continue;
    const path = join(segmentsDirectory, entry.name);
    try {
      if (now - (await stat(path)).mtimeMs <= LOCAL_TRACE_QUIESCENCE_MS) continue;
      await rm(path, { force: true });
    } catch {}
  }
}

async function directoryMtime(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function directorySize(path: string): Promise<number> {
  const entries = await readDirectoryEntries(path);
  if (entries === undefined) return 0;
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(child);
      continue;
    }
    try {
      total += (await stat(child)).size;
    } catch {}
  }
  return total;
}

async function readDirectoryEntries(path: string): Promise<Dirent<string>[] | undefined> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }
    throw error;
  }
}

function isDisabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "off" || normalized === "false" || normalized === "0";
}

function readBound(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): RetentionBound {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "false") return false;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    log.warn("ignoring invalid local trace retention value", { fallback, name, value: raw });
    return fallback;
  }
  return parsed;
}

function clampBound(value: RetentionBound): RetentionBound {
  return value === false ? false : Math.max(0, value);
}

function clampCount(value: RetentionBound): RetentionBound {
  return value === false ? false : Math.max(0, Math.trunc(value));
}
