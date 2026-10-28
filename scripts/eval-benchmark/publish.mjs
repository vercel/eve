// Publishes one benchmark run to private Vercel Blob. Every object is
// immutable; re-running with identical content is a no-op and different
// content fails. manifest.json is written last, so its presence tells ingest
// the run is complete:
//
//   runs/<github_run_id>/<run_attempt>/raw/<fixture>/<model>/<world>/<attempt>/...
//   runs/<github_run_id>/<run_attempt>/raw/dev-startup/...
//   runs/<github_run_id>/<run_attempt>/records.jsonl
//   runs/<github_run_id>/<run_attempt>/framework-records.jsonl
//   runs/<github_run_id>/<run_attempt>/manifest.json
//
// The manifest lists both record files and carries the metric catalog (unit,
// direction, and scope of every metric), so ingest reads scopes from the run.
//
// A release backfill (a plan with a `source`, see release.mjs) publishes
// under imports/metrics-v<METRICS_VERSION>/runs/ instead of runs/, with the
// plan's source in its manifest: it is not a run of main.
//
// Usage: node scripts/eval-benchmark/publish.mjs <plan.json> <legs-dir> <records.jsonl> <dev-startup-dir> <framework-records.jsonl>
// Requires EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  METRICS_VERSION,
  METRIC_DEFINITIONS,
  STANDARD_METRICS,
} from "../eval-metrics/standard.mjs";
import {
  DEV_STARTUP_ARTIFACT_PATH,
  FRAMEWORK_RECORD_METRICS,
  FRAMEWORK_RECORD_SCHEMA_VERSION,
} from "./framework-records.mjs";
import { RECORD_SCHEMA_VERSION, legArtifactPath, readLegs } from "./records.mjs";

const UPLOAD_CONCURRENCY = 8;

/**
 * @typedef {{
 *   put: (pathname: string, body: Buffer, contentType: string) => Promise<void>,
 *   read: (pathname: string) => Promise<Buffer | null>,
 *   list?: (prefix: string) => Promise<string[]>,
 * }} ImmutableStore `put` must reject with an "already exists" error rather than overwrite.
 */

/** Where a plan's run is published: main's runs, or the import root for a backfill. */
export function publishRoot(plan) {
  return plan.source === undefined ? "runs" : `imports/metrics-v${METRICS_VERSION}/runs`;
}

/**
 * `root` and `source` let an importer publish runs it did not execute (see
 * import-stress-artifacts.mjs) outside `runs/`, saying where they came from.
 * They default to the plan's: a release backfill's plan has a `source`.
 *
 * @param {{ plan: any, legs: ReturnType<typeof readLegs>, recordsJsonl: string, frameworkRecordsJsonl: string, devStartupDir?: string, githubRunId: string, runAttempt: number, eveVersion: string, store: ImmutableStore, root?: string, source?: object }} input
 */
export async function publishRun({
  plan,
  legs,
  recordsJsonl,
  frameworkRecordsJsonl,
  devStartupDir,
  githubRunId,
  runAttempt,
  eveVersion,
  store,
  root = publishRoot(plan),
  source = plan.source,
}) {
  const parse = (jsonl) =>
    jsonl
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const records = parse(recordsJsonl);
  const frameworkRecords = parse(frameworkRecordsJsonl);
  for (const record of [...records, ...frameworkRecords]) {
    if (record.github_run_id !== String(githubRunId) || record.run_attempt !== runAttempt)
      throw new Error(
        `Record ${record.fixture ?? record.probe}/${record.eval_id ?? record.subject} belongs to another run.`,
      );
  }

  const prefix = `${root}/${githubRunId}/${runAttempt}`;
  const tree = (dir, artifactPath) =>
    listFiles(dir).map((path) => ({
      pathname: `${prefix}/${artifactPath}/${relative(dir, path).replaceAll("\\", "/")}`,
      path,
    }));
  const uploads = [
    ...legs.flatMap(({ leg, dir }) => (dir === undefined ? [] : tree(dir, legArtifactPath(leg)))),
    ...(devStartupDir !== undefined && existsSync(devStartupDir)
      ? tree(devStartupDir, DEV_STARTUP_ARTIFACT_PATH)
      : []),
  ];
  await mapLimit(uploads, UPLOAD_CONCURRENCY, ({ pathname, path }) =>
    putImmutable(store, pathname, readFileSync(path), contentTypeOf(path)),
  );

  const recordsBody = Buffer.from(recordsJsonl);
  const frameworkRecordsBody = Buffer.from(frameworkRecordsJsonl);
  await putImmutable(store, `${prefix}/records.jsonl`, recordsBody, "application/x-ndjson");
  await putImmutable(
    store,
    `${prefix}/framework-records.jsonl`,
    frameworkRecordsBody,
    "application/x-ndjson",
  );
  const sha256 = (body) => createHash("sha256").update(body).digest("hex");
  const manifest = {
    schema_version: RECORD_SCHEMA_VERSION,
    github_run_id: String(githubRunId),
    run_attempt: runAttempt,
    sha: plan.sha,
    eve_version: eveVersion,
    planned_at: plan.planned_at,
    ...(source === undefined ? {} : { source }),
    registry: plan.registry,
    legs: legs.map(({ leg, dir }) => ({ ...leg, uploaded: dir !== undefined })),
    record_count: records.length,
    records_sha256: sha256(recordsBody),
    files: {
      records: {
        path: "records.jsonl",
        schema_version: RECORD_SCHEMA_VERSION,
        count: records.length,
        sha256: sha256(recordsBody),
      },
      framework_records: {
        path: "framework-records.jsonl",
        schema_version: FRAMEWORK_RECORD_SCHEMA_VERSION,
        count: frameworkRecords.length,
        sha256: sha256(frameworkRecordsBody),
      },
    },
    metrics: {
      metrics_version: METRICS_VERSION,
      definitions: METRIC_DEFINITIONS,
      records: STANDARD_METRICS,
      framework_records: FRAMEWORK_RECORD_METRICS,
    },
  };
  await putImmutable(
    store,
    `${prefix}/manifest.json`,
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    "application/json",
  );
  return {
    prefix,
    objects: uploads.length + 3,
    records: records.length,
    frameworkRecords: frameworkRecords.length,
  };
}

export async function putImmutable(store, pathname, body, contentType) {
  try {
    await store.put(pathname, body, contentType);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
    const published = await store.read(pathname);
    if (published === null) throw new Error(`${pathname} exists but could not be read back.`);
    if (!published.equals(body)) {
      throw new Error(
        `${pathname} was already published with different content; benchmark runs are immutable. Re-run the workflow to get a new run attempt instead.`,
      );
    }
  }
}

export function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

export function contentTypeOf(path) {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".ndjson") || path.endsWith(".jsonl")) return "application/x-ndjson";
  return "application/octet-stream";
}

export async function mapLimit(items, limit, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  });
  await Promise.all(workers);
}

/** Private, immutable Blob store backed by @vercel/blob. */
export async function vercelBlobStore(token) {
  const { get, list, put } = await import("@vercel/blob");
  return {
    async put(pathname, body, contentType) {
      await put(pathname, body, {
        token,
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
        cacheControlMaxAge: 31_536_000,
        contentType,
      });
    },
    async read(pathname) {
      const result = await get(pathname, { token, access: "private", useCache: false });
      return result === null ? null : Buffer.from(await new Response(result.stream).arrayBuffer());
    },
    async list(prefix) {
      const pathnames = [];
      let cursor;
      for (let page = 0; page < 100; page += 1) {
        const result = await list({ token, prefix, cursor, limit: 1000 });
        pathnames.push(...result.blobs.map((blob) => blob.pathname));
        if (!result.hasMore) return pathnames;
        cursor = result.cursor;
      }
      throw new Error(`More than 100 pages of blobs under ${prefix}.`);
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [planPath, legsDir, recordsPath, devStartupDir, frameworkRecordsPath] =
    process.argv.slice(2);
  if (frameworkRecordsPath === undefined) {
    console.error(
      "Usage: node scripts/eval-benchmark/publish.mjs <plan.json> <legs-dir> <records.jsonl> <dev-startup-dir> <framework-records.jsonl>",
    );
    process.exit(1);
  }
  const token = process.env.EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN;
  if (!token)
    throw new Error(
      "EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN is required to publish benchmark results.",
    );
  const githubRunId = process.env.GITHUB_RUN_ID;
  if (githubRunId === undefined)
    throw new Error("GITHUB_RUN_ID is required to key the published run.");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const result = await publishRun({
    plan,
    legs: readLegs(plan, legsDir),
    recordsJsonl: readFileSync(recordsPath, "utf8"),
    frameworkRecordsJsonl: readFileSync(frameworkRecordsPath, "utf8"),
    devStartupDir,
    githubRunId,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? "1"),
    // The code under test's version, which a backfill's harness does not share.
    eveVersion: plan.eve_version,
    store: await vercelBlobStore(token),
  });
  console.error(
    `Published ${result.records} records, ${result.frameworkRecords} framework records, and ${result.objects} objects to ${result.prefix}.`,
  );
}
