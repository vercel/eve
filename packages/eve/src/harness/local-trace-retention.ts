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
 * How long a trace must sit untouched before a sweep may act on it.
 *
 * Liveness is tracked per dev worker, so a draining worker's writes and a
 * waiting session restored into a replacement worker are both invisible to the
 * open-session set. Recent writes are the one liveness signal that crosses
 * processes, so nothing written this recently is evicted, and an
 * `atomicWriteFile` temp file is only reaped once this stale — a real write
 * renames within milliseconds.
 */
const LOCAL_TRACE_QUIESCENCE_MS = 5 * 60 * 1_000;

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
  /** Traces whose session is open in this worker; never evicted. */
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
 * A trace survives while its session is open, while it was written within the
 * quiescence window, while it is among the newest `retainCount`, and while it
 * is younger than `maxAgeMs`. Everything else is evicted oldest-first, taking
 * the age bound first and then whatever the `maxTotalBytes` budget still
 * demands.
 *
 * The count floor outranks both other bounds deliberately: a trace records
 * something that happened and cannot be regenerated, so returning to a quiet
 * project should not mean returning to an empty store.
 */
export async function pruneLocalTraceStore(
  input: PruneLocalTraceStoreInput,
): Promise<LocalTracePruneResult> {
  const now = input.now ?? Date.now();
  const maxAgeMs = clampBound(input.maxAgeMs ?? LOCAL_TRACE_MAX_AGE_MS);
  const maxTotalBytes = clampBound(input.maxTotalBytes ?? LOCAL_TRACE_MAX_TOTAL_BYTES);
  const retainCount = clampCount(input.retainCount ?? LOCAL_TRACE_RETAIN_COUNT);

  const traces = await readStoredTraces(input.appRoot, now);
  const newestFirst = [...traces].sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  // `off` disables the bound, and this bound is a floor: disabling it removes
  // the keep-newest guarantee rather than granting unlimited retention.
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

/**
 * Requests a sweep without blocking the caller.
 *
 * One pending request is coalesced rather than dropped, so a session that
 * finishes while a sweep is already running still gets swept — the same
 * guarantee `requestDevelopmentGenerationPrune` gives dev runtime generations.
 * Failures are reported and otherwise swallowed: an unbounded store is
 * preferable to a broken dev server.
 */
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

/**
 * Reports at `info` so it survives the default log threshold: a trace cannot be
 * regenerated, and there is no trace browser yet, so a silent deletion is
 * indistinguishable from a span that was never captured.
 */
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
        // Segments are added and never rewritten, so that directory's mtime is
        // when the trace last received a span. A trace directory without one
        // falls back to its own mtime so it is still bounded rather than
        // invisible to the policy.
        const modifiedAtMs = (await directoryMtime(segments)) ?? (await directoryMtime(path));
        if (modifiedAtMs === undefined) return undefined;
        return {
          // Measured across the whole trace directory, so anything the writer
          // leaves behind counts against the budget.
          byteSize: await directorySize(path),
          modifiedAtMs,
          path,
          traceId: entry.name,
        };
      }),
  );
  return traces.filter((trace): trace is StoredTrace => trace !== undefined);
}

/**
 * Removes `atomicWriteFile` temp files left by a killed process. It clears its
 * own on a failed rename, but a process killed between write and rename leaves
 * one behind and nothing else would ever reclaim those bytes.
 */
async function reapAbandonedTemporaryFiles(segmentsDirectory: string, now: number): Promise<void> {
  const entries = await readDirectoryEntries(segmentsDirectory);
  if (entries === undefined) return;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.includes(".tmp-")) continue;
    const path = join(segmentsDirectory, entry.name);
    try {
      if (now - (await stat(path)).mtimeMs <= LOCAL_TRACE_QUIESCENCE_MS) continue;
      await rm(path, { force: true });
    } catch {
      // Raced with the writer that owns it; the next sweep sees the outcome.
    }
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
    } catch {
      // Disappeared mid-sweep; it contributes nothing to the measured size.
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
