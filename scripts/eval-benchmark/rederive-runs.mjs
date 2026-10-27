// Re-derives published benchmark runs under the current METRICS_VERSION from
// the raw leg artifacts each run keeps, so a metric definition change applies
// to the runs before it. Imports need none of this: a new metrics version
// writes a new import root (see import-stress-artifacts.mjs). Benchmark runs
// keep their ids, so their records and manifest are rewritten in place:
//
//   1. the run's records.jsonl and manifest.json are copied to
//      superseded/metrics-v<old>/<run prefix>/
//   2. its manifest is removed, so readers stop treating the run as complete
//   3. records.jsonl is replaced, then the manifest is written last
//
// A re-derivation only changes metrics: one whose records name different
// attempts than the published run fails before anything is written. Readers
// that cache completed runs keep the old records until they restart.
//
// Usage: node scripts/eval-benchmark/rederive-runs.mjs [--dry-run] [--root runs --root preview/runs]
// Requires EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN; with --dry-run, read access
// (such as eve-evals' OIDC credentials) suffices.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  METRICS_VERSION,
  METRIC_DEFINITIONS,
  STANDARD_METRICS,
} from "../eval-metrics/standard.mjs";
import { mapLimit, putImmutable, vercelBlobStore } from "./publish.mjs";
import { LEG_ARTIFACT_PREFIX, buildRecords, legArtifactPath, readLegs } from "./records.mjs";

const DOWNLOAD_CONCURRENCY = 48;
const DOWNLOAD_ATTEMPTS = 4;

/**
 * @typedef {import("./publish.mjs").ImmutableStore & {
 *   list: (prefix: string) => Promise<string[]>,
 *   folders: (prefix: string) => Promise<string[]>,
 *   replace: (pathname: string, body: Buffer, contentType: string) => Promise<void>,
 *   remove: (pathname: string) => Promise<void>,
 * }} MutableStore `folders` lists the immediate subfolders of a prefix, each ending in `/`.
 */

/** Every published run attempt under a root, as `<root>/<run id>/<attempt>`. */
export async function listRuns(store, root) {
  const runs = await store.folders(`${root}/`);
  const attempts = await Promise.all(runs.map((run) => store.folders(run)));
  return attempts.flat().map((prefix) => prefix.replace(/\/$/, ""));
}

/**
 * @param {{ store: MutableStore, prefix: string, dryRun?: boolean }} input
 * @returns {Promise<{ status: "incomplete" | "current" | "rederived", from?: number, records?: number }>}
 */
export async function rederiveRun({ store, prefix, dryRun = false }) {
  const manifestBody = await store.read(`${prefix}/manifest.json`);
  if (manifestBody === null) return { status: "incomplete" };
  const manifest = JSON.parse(manifestBody.toString("utf8"));
  const from = manifest.metrics?.metrics_version;
  if (from === METRICS_VERSION) return { status: "current", from };

  const recordsPath = `${prefix}/${manifest.files.records.path}`;
  const publishedBody = await store.read(recordsPath);
  if (publishedBody === null) throw new Error(`${recordsPath} is missing.`);
  const published = parseJsonl(publishedBody.toString("utf8"));

  const plan = {
    sha: manifest.sha,
    registry: manifest.registry,
    legs: manifest.legs.map(({ uploaded: _uploaded, ...leg }) => leg),
  };
  const legsDir = mkdtempSync(join(tmpdir(), "eve-rederive-"));
  try {
    await downloadLegs({ store, prefix, legs: manifest.legs, legsDir });
    const { records } = buildRecords({
      plan,
      legs: readLegs(plan, legsDir),
      githubRunId: manifest.github_run_id,
      runAttempt: manifest.run_attempt,
    });
    const before = published.map(attemptKey).sort();
    const after = records.map(attemptKey).sort();
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error(
        `${prefix}: re-derived records name different attempts than the published run (${before.length} published, ${after.length} re-derived).`,
      );
    if (dryRun) return { status: "rederived", from, records: records.length };

    const superseded = `superseded/metrics-v${from}/${prefix}`;
    await putImmutable(
      store,
      `${superseded}/${manifest.files.records.path}`,
      publishedBody,
      "application/x-ndjson",
    );
    await putImmutable(store, `${superseded}/manifest.json`, manifestBody, "application/json");

    const recordsBody = Buffer.from(
      records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    );
    const digest = sha256(recordsBody);
    const next = {
      ...manifest,
      record_count: records.length,
      records_sha256: digest,
      files: {
        ...manifest.files,
        records: { ...manifest.files.records, count: records.length, sha256: digest },
      },
      metrics: {
        ...manifest.metrics,
        metrics_version: METRICS_VERSION,
        definitions: METRIC_DEFINITIONS,
        records: STANDARD_METRICS,
      },
    };
    await store.remove(`${prefix}/manifest.json`);
    await store.replace(recordsPath, recordsBody, "application/x-ndjson");
    await store.replace(
      `${prefix}/manifest.json`,
      Buffer.from(`${JSON.stringify(next, null, 2)}\n`),
      "application/json",
    );
    return { status: "rederived", from, records: records.length };
  } finally {
    rmSync(legsDir, { recursive: true, force: true });
  }
}

/** Download each uploaded leg's JSON artifacts into the layout records.mjs reads. */
async function downloadLegs({ store, prefix, legs, legsDir }) {
  const files = [];
  for (const leg of legs) {
    if (!leg.uploaded) continue;
    const legPrefix = `${prefix}/${legArtifactPath(leg)}/`;
    for (const pathname of await store.list(legPrefix)) {
      // Records read only JSON: meta, expected, eval details, world probes.
      if (!pathname.endsWith(".json")) continue;
      files.push({
        pathname,
        path: join(
          legsDir,
          `${LEG_ARTIFACT_PREFIX}${leg.leg_id}`,
          pathname.slice(legPrefix.length),
        ),
      });
    }
  }
  await mapLimit(files, DOWNLOAD_CONCURRENCY, async ({ pathname, path }) => {
    const body = await readWithRetries(store, pathname);
    if (body === null) throw new Error(`${pathname} was listed but could not be read.`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  });
}

/** Thousands of reads per run: retry the transient network failures some of them hit. */
async function readWithRetries(store, pathname) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await store.read(pathname);
    } catch (error) {
      if (attempt >= DOWNLOAD_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

function attemptKey(record) {
  return [record.fixture, record.eval_id, record.model_id, record.world, record.attempt].join("\0");
}

function parseJsonl(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

/** The benchmark Blob store, with the in-place writes a re-derivation needs. */
async function mutableBlobStore(token) {
  const { del, list, put } = await import("@vercel/blob");
  return {
    ...(await vercelBlobStore(token)),
    async folders(prefix) {
      const folders = [];
      let cursor;
      do {
        const result = await list({ token, prefix, cursor, mode: "folded", limit: 1000 });
        folders.push(...(result.folders ?? []));
        cursor = result.hasMore ? result.cursor : undefined;
      } while (cursor !== undefined);
      return folders;
    },
    async replace(pathname, body, contentType) {
      await put(pathname, body, {
        token,
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
        contentType,
      });
    },
    async remove(pathname) {
      await del(pathname, { token });
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      root: { type: "string", multiple: true, default: ["runs", "preview/runs"] },
    },
  });
  const dryRun = values["dry-run"];
  const token = process.env.EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN;
  if (!token && !dryRun)
    throw new Error("EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN is required to rewrite benchmark runs.");
  const store = await mutableBlobStore(token || undefined);

  const counts = { rederived: 0, current: 0, incomplete: 0, failed: 0 };
  for (const root of values.root) {
    for (const prefix of await listRuns(store, root)) {
      try {
        const result = await rederiveRun({ store, prefix, dryRun });
        counts[result.status] += 1;
        const detail =
          result.status === "rederived"
            ? `${dryRun ? "would re-derive" : "re-derived"} ${result.records} records from metrics v${result.from}`
            : result.status;
        console.error(`${prefix}: ${detail}`);
      } catch (error) {
        counts.failed += 1;
        console.error(
          `${prefix}: failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  console.error(
    `${dryRun ? "Would re-derive" : "Re-derived"} ${counts.rederived} runs to metrics v${METRICS_VERSION}; ${counts.current} already current, ${counts.incomplete} incomplete, ${counts.failed} failed.`,
  );
  if (counts.failed > 0) process.exitCode = 1;
}
