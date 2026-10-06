// Publishes one benchmark run to private Vercel Blob. Every object is
// immutable; re-running with identical content is a no-op and different
// content fails. manifest.json is written last, so its presence tells ingest
// the run is complete:
//
//   runs/<github_run_id>/<run_attempt>/raw/<fixture>/<model>/<world>/<attempt>/...
//   runs/<github_run_id>/<run_attempt>/records.jsonl
//   runs/<github_run_id>/<run_attempt>/manifest.json
//
// Usage: node scripts/eval-benchmark/publish.mjs <plan.json> <legs-dir> <records.jsonl>
// Requires EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT.
// TEMPORARY: EVE_BENCHMARK_BLOB_ROOT=preview/runs keeps pull request test runs
// out of the runs/ prefix that ingest reads. Remove before merge.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RECORD_SCHEMA_VERSION,
  assertValidRecords,
  legArtifactPath,
  readLegs,
} from "./records.mjs";

const UPLOAD_CONCURRENCY = 8;
const BLOB_ROOTS = ["runs", "preview/runs"];

/**
 * @typedef {{
 *   put: (pathname: string, body: Buffer, contentType: string) => Promise<void>,
 *   read: (pathname: string) => Promise<Buffer | null>,
 * }} ImmutableStore `put` must reject with an "already exists" error rather than overwrite.
 */

/**
 * @param {{ plan: any, legs: ReturnType<typeof readLegs>, recordsJsonl: string, githubRunId: string, runAttempt: number, eveVersion: string, store: ImmutableStore, root?: string }} input
 */
export async function publishRun({
  plan,
  legs,
  recordsJsonl,
  githubRunId,
  runAttempt,
  eveVersion,
  store,
  root = "runs",
}) {
  if (!BLOB_ROOTS.includes(root))
    throw new Error(`Blob root must be one of ${BLOB_ROOTS.join(", ")} (got "${root}").`);
  const records = recordsJsonl
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assertValidRecords(records);
  for (const record of records) {
    if (record.github_run_id !== String(githubRunId) || record.run_attempt !== runAttempt)
      throw new Error(`Record ${record.fixture}/${record.eval_id} belongs to another run.`);
  }

  const prefix = `${root}/${githubRunId}/${runAttempt}`;
  const uploads = legs.flatMap(({ leg, dir }) =>
    dir === undefined
      ? []
      : listFiles(dir).map((path) => ({
          pathname: `${prefix}/${legArtifactPath(leg)}/${relative(dir, path).replaceAll("\\", "/")}`,
          path,
        })),
  );
  await mapLimit(uploads, UPLOAD_CONCURRENCY, ({ pathname, path }) =>
    putImmutable(store, pathname, readFileSync(path), contentTypeOf(path)),
  );

  const recordsBody = Buffer.from(recordsJsonl);
  await putImmutable(store, `${prefix}/records.jsonl`, recordsBody, "application/x-ndjson");
  const manifest = {
    schema_version: RECORD_SCHEMA_VERSION,
    github_run_id: String(githubRunId),
    run_attempt: runAttempt,
    sha: plan.sha,
    eve_version: eveVersion,
    planned_at: plan.planned_at,
    registry: plan.registry,
    legs: legs.map(({ leg, dir }) => ({ ...leg, uploaded: dir !== undefined })),
    record_count: records.length,
    records_sha256: createHash("sha256").update(recordsBody).digest("hex"),
  };
  await putImmutable(
    store,
    `${prefix}/manifest.json`,
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    "application/json",
  );
  return { prefix, objects: uploads.length + 2, records: records.length };
}

async function putImmutable(store, pathname, body, contentType) {
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

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function contentTypeOf(path) {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".ndjson") || path.endsWith(".jsonl")) return "application/x-ndjson";
  return "application/octet-stream";
}

async function mapLimit(items, limit, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  });
  await Promise.all(workers);
}

/** Private, immutable Blob store backed by @vercel/blob. */
export async function vercelBlobStore(token) {
  const { get, put } = await import("@vercel/blob");
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
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [planPath, legsDir, recordsPath] = process.argv.slice(2);
  if (recordsPath === undefined) {
    console.error(
      "Usage: node scripts/eval-benchmark/publish.mjs <plan.json> <legs-dir> <records.jsonl>",
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
    githubRunId,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? "1"),
    eveVersion: JSON.parse(readFileSync("packages/eve/package.json", "utf8")).version,
    store: await vercelBlobStore(token),
    root: process.env.EVE_BENCHMARK_BLOB_ROOT || undefined,
  });
  console.error(
    `Published ${result.records} records and ${result.objects} objects to ${result.prefix}.`,
  );
}
