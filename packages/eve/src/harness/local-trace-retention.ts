import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  resolveLocalTraceSchemaDirectory,
  resolveLocalTraceSegmentsDirectory,
} from "#harness/local-trace-span-processor.js";
import { createLogger, formatError } from "#internal/logging.js";

const log = createLogger("harness.local-trace-retention");

/**
 * How long an `atomicWriteFile` temp file must sit untouched before a sweep
 * treats it as abandoned. A real write renames within milliseconds, so anything
 * this old belongs to a killed process — and reaping a live one would break the
 * write it belongs to.
 */
const LOCAL_TRACE_ABANDONED_TEMP_FILE_MS = 5 * 60 * 1_000;

const LOCAL_TRACE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const LOCAL_TRACE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const LOCAL_TRACE_RETAIN_COUNT = 20;

/**
 * A bound that may be switched off individually, mirroring the `number | false`
 * idiom used by authored agent limits.
 */
type RetentionBound = number | false;

/** Resolved retention policy for one dev worker. */
export interface LocalTraceRetentionSettings {
  readonly enabled: boolean;
  readonly maxAgeMs: RetentionBound;
  readonly maxTotalBytes: RetentionBound;
  readonly retainCount: RetentionBound;
}

/** Which bound removed traces, reported for a single diagnostics line. */
export type LocalTracePruneReason = "maxAgeMs" | "maxTotalBytes";

/** Outcome of one sweep. `removedTraces` counts trace directories, not spans. */
export interface LocalTracePruneResult {
  readonly reasons: readonly LocalTracePruneReason[];
  readonly reclaimedBytes: number;
  readonly removedTraces: number;
  readonly retainedTraces: number;
}

export interface PruneLocalTraceStoreInput {
  readonly appRoot: string;
  /** Traces whose session is still open; never evicted, even mid-write. */
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

/**
 * Reads the retention policy from the environment.
 *
 * `eve dev` loads `.env.local` into `process.env` before the tracing runtime
 * installs, so these are authored there rather than in `agent.ts`: the store is
 * a property of one developer's machine, not of the deployed agent.
 *
 * Every bound accepts `off` to disable that axis alone. Unparseable values warn
 * and fall back to the default instead of throwing, because a typo in a dev env
 * file should not prevent the agent from booting.
 */
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

/**
 * Bounds the local trace store.
 *
 * A trace survives when its session is still open, when it is among the newest
 * `retainCount`, or when it is younger than `maxAgeMs`. Whatever survives is
 * then evicted oldest-first while the store exceeds `maxTotalBytes`, never
 * dropping an active trace and never breaching the count floor.
 *
 * The count floor outranks age deliberately: a trace records something that
 * happened and cannot be regenerated, so returning to a quiet project should
 * not mean returning to an empty store.
 */
export async function pruneLocalTraceStore(
  input: PruneLocalTraceStoreInput,
): Promise<LocalTracePruneResult> {
  const now = input.now ?? Date.now();
  const maxAgeMs = clampBound(input.maxAgeMs ?? LOCAL_TRACE_MAX_AGE_MS);
  const maxTotalBytes = clampBound(input.maxTotalBytes ?? LOCAL_TRACE_MAX_TOTAL_BYTES);
  const retainCount = clampCount(input.retainCount ?? LOCAL_TRACE_RETAIN_COUNT);

  const reasons = new Set<LocalTracePruneReason>();
  let reclaimedBytes = 0;
  let removedTraces = 0;

  const traces = await readStoredTraces(input.appRoot, now);
  const byNewestFirst = [...traces].sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  // `off` disables the bound, and this bound is a floor: disabling it removes
  // the keep-newest guarantee rather than granting unlimited retention.
  const floor = new Set(byNewestFirst.slice(0, retainCount === false ? 0 : retainCount));

  const survivors: StoredTrace[] = [];
  for (const trace of byNewestFirst) {
    const protectedTrace =
      input.activeTraceIds.has(trace.traceId) ||
      floor.has(trace) ||
      maxAgeMs === false ||
      now - trace.modifiedAtMs <= maxAgeMs;
    if (protectedTrace) {
      survivors.push(trace);
      continue;
    }
    reclaimedBytes += await removeDirectory(trace.path);
    removedTraces += 1;
    reasons.add("maxAgeMs");
  }

  if (maxTotalBytes !== false) {
    let total = survivors.reduce((sum, trace) => sum + trace.byteSize, 0);
    // Oldest-first, and stop at the floor: the budget may not delete what the
    // keep-newest guarantee promised.
    for (const trace of [...survivors].reverse()) {
      if (total <= maxTotalBytes) break;
      if (input.activeTraceIds.has(trace.traceId) || floor.has(trace)) continue;
      total -= trace.byteSize;
      reclaimedBytes += await removeDirectory(trace.path);
      removedTraces += 1;
      survivors.splice(survivors.indexOf(trace), 1);
      reasons.add("maxTotalBytes");
    }
  }

  return {
    reasons: [...reasons],
    reclaimedBytes,
    removedTraces,
    retainedTraces: survivors.length,
  };
}

let inFlight: Promise<void> | undefined;

/**
 * Requests a sweep without blocking the caller.
 *
 * Concurrent requests are dropped rather than queued: the next session terminal
 * requests again, so the store still converges, and a sweep never delays a
 * harness step. Failures are reported once per sweep and otherwise swallowed —
 * an unbounded store is preferable to a broken dev server.
 */
export function requestLocalTraceStorePrune(input: PruneLocalTraceStoreInput): void {
  if (inFlight !== undefined) return;
  inFlight = pruneLocalTraceStore(input)
    .then((result) => {
      if (result.removedTraces === 0 && result.reclaimedBytes === 0) return;
      log.debug("pruned local traces", {
        reasons: result.reasons.join(","),
        reclaimedBytes: result.reclaimedBytes,
        removedTraces: result.removedTraces,
        retainedTraces: result.retainedTraces,
      });
    })
    .catch((error: unknown) => {
      log.warn("local trace retention failed", { error: formatError(error) });
    })
    .finally(() => {
      inFlight = undefined;
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
        const segments = resolveLocalTraceSegmentsDirectory(appRoot, entry.name);
        const measured = await measureSegments(segments, now);
        if (measured === undefined) return undefined;
        return {
          byteSize: measured.byteSize,
          modifiedAtMs: measured.modifiedAtMs,
          path: join(schemaDirectory, entry.name),
          traceId: entry.name,
        };
      }),
  );
  return traces.filter((trace): trace is StoredTrace => trace !== undefined);
}

/**
 * Sums a trace's segments and reports when it last received one.
 *
 * Also reaps `atomicWriteFile` temp files: it removes its own on a failed
 * rename, but a process killed between write and rename leaves one behind, and
 * nothing else would ever reclaim those bytes.
 */
async function measureSegments(
  segmentsDirectory: string,
  now: number,
): Promise<{ byteSize: number; modifiedAtMs: number } | undefined> {
  const entries = await readDirectoryEntries(segmentsDirectory);
  if (entries === undefined) return undefined;

  let byteSize = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(segmentsDirectory, entry.name);
    try {
      const stats = await stat(path);
      if (!entry.name.includes(".tmp-")) {
        byteSize += stats.size;
        continue;
      }
      if (now - stats.mtimeMs > LOCAL_TRACE_ABANDONED_TEMP_FILE_MS) {
        await rm(path, { force: true }).catch(() => undefined);
      }
    } catch {
      // Raced with a concurrent writer; the next sweep sees the settled file.
    }
  }

  try {
    return { byteSize, modifiedAtMs: (await stat(segmentsDirectory)).mtimeMs };
  } catch {
    return undefined;
  }
}

async function removeDirectory(path: string): Promise<number> {
  const byteSize = await directorySize(path);
  await rm(path, { force: true, recursive: true });
  return byteSize;
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
    } catch {
      // Disappeared mid-sweep; it contributes nothing to reclaimed bytes.
    }
  }
  return total;
}

async function readDirectoryEntries(path: string): Promise<Dirent<string>[] | undefined> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
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
