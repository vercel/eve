// Mirrors e2e-vercel's `workflow-stress-performance` artifacts from release
// pull requests (`changeset-release/main`, whose build is exactly the
// published release) to the benchmark Blob store before GitHub's 30-day
// retention deletes them. They are the only hosted, version-aligned history
// of agent-workflow-stress from before the benchmark ran it.
//
//   imports/workflow-stress/<github_run_id>/<artifact_id>/artifact.zip    the artifact, byte for byte
//   imports/workflow-stress/<github_run_id>/<artifact_id>/metadata.json   written last: the mirror is complete
//
// Benchmark viewers list only `runs/` and `preview/runs/`, so imports stay
// out of them until something derives records from these archives. Objects
// are immutable and metadata.json is deterministic, so re-running skips what
// is mirrored and retries what is not. A release PR runs once per push, so
// several archives can carry one eve version. The release build is the one
// whose head_sha is the release PR's final head commit; a cancelled or failed
// final run uploads nothing, so the latest archive is not always that build.
//
// .github/workflows/mirror-stress-artifacts.yml runs it daily.
//
// Usage: node scripts/eval-benchmark/mirror-stress-artifacts.mjs [--dry-run] [--repo vercel/eve] [--branch changeset-release/main]
// Requires a GitHub token with actions:read (GITHUB_TOKEN, GH_TOKEN, or `gh auth login`)
// and, unless --dry-run, EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { putImmutable, vercelBlobStore } from "./publish.mjs";

const MIRROR_SCHEMA_VERSION = 1;
const ARTIFACT_NAME = "workflow-stress-performance";
const PREFIX = "imports/workflow-stress";
const REPORT_PATH = ".artifacts/workflow-stress-report.json";
const EVAL_ARTIFACT = /(^|\/)\.eve\/evals\/[^/]+\/evals\/[^/]+\.json$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 200;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

/** Every unexpired artifact named `name` from runs on `branch`, oldest first. */
async function listArtifacts({ repo, branch, token }) {
  const artifacts = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `https://api.github.com/repos/${repo}/actions/artifacts?name=${ARTIFACT_NAME}&per_page=${PAGE_SIZE}&page=${page}`;
    const body = await (await github(url, token)).json();
    artifacts.push(...body.artifacts);
    if (body.artifacts.length < PAGE_SIZE) break;
    if (page === MAX_PAGES)
      throw new Error(`More than ${MAX_PAGES} pages of ${ARTIFACT_NAME} artifacts.`);
  }
  // A fork can name its branch changeset-release/main too; only same-repository runs are release builds.
  return artifacts
    .filter(
      (artifact) =>
        !artifact.expired &&
        artifact.workflow_run?.head_branch === branch &&
        artifact.workflow_run.head_repository_id === artifact.workflow_run.repository_id,
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function github(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return response;
}

/** Downloads an artifact's archive and checks it against GitHub's digest. */
async function downloadArchive(artifact, token) {
  if (artifact.size_in_bytes > MAX_ARCHIVE_BYTES)
    throw new Error(
      `Artifact ${artifact.id} is ${artifact.size_in_bytes} bytes, over the ${MAX_ARCHIVE_BYTES}-byte cap.`,
    );
  // The signed redirect target is cross-origin, so fetch drops the token there.
  const archive = Buffer.from(
    await (await github(artifact.archive_download_url, token)).arrayBuffer(),
  );
  if (archive.length > MAX_ARCHIVE_BYTES)
    throw new Error(`Artifact ${artifact.id} downloaded ${archive.length} bytes, over the cap.`);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  if (artifact.digest !== `sha256:${sha256}`)
    throw new Error(
      `Artifact ${artifact.id} digest is sha256:${sha256}, but GitHub reports ${artifact.digest ?? "no digest"}.`,
    );
  return { archive, sha256 };
}

/** The eve version and run identity a stress archive records. */
function inspectArchive(archive) {
  const dir = mkdtempSync(join(tmpdir(), "eve-stress-"));
  try {
    const zip = join(dir, "artifact.zip");
    writeFileSync(zip, archive);
    const unzip = (...args) =>
      execFileSync("unzip", [...args], { encoding: "utf8", maxBuffer: MAX_ARCHIVE_BYTES });
    const names = unzip("-Z1", zip).split("\n").filter(Boolean);
    const read = (name) => JSON.parse(unzip("-p", zip, name));

    if (!names.includes(REPORT_PATH)) throw new Error(`The archive has no ${REPORT_PATH}.`);
    const report = read(REPORT_PATH);
    const versions = new Set(
      names
        .filter((name) => EVAL_ARTIFACT.test(name))
        .map((name) => read(name)?.result?.runtimeIdentity?.eveVersion)
        .filter((version) => typeof version === "string"),
    );
    if (versions.size !== 1)
      throw new Error(
        `Expected one eve version across the eval artifacts, found ${versions.size}.`,
      );
    return {
      eveVersion: [...versions][0],
      attempt: Number(report.metadata?.attempt),
      mergeSha: report.metadata?.sha ?? null,
      reportGeneratedAt: report.generatedAt ?? null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function metadataFor({ repo, artifact, sha256, archive, inspected }) {
  return {
    schema_version: MIRROR_SCHEMA_VERSION,
    source: "github-actions-artifact",
    repository: repo,
    eve_version: inspected.eveVersion,
    artifact: {
      id: artifact.id,
      name: artifact.name,
      sha256,
      size_bytes: archive.length,
      created_at: artifact.created_at,
      expires_at: artifact.expires_at,
    },
    workflow_run: {
      id: artifact.workflow_run.id,
      attempt: Number.isInteger(inspected.attempt) ? inspected.attempt : null,
      head_branch: artifact.workflow_run.head_branch,
      head_sha: artifact.workflow_run.head_sha,
      // The pull_request merge ref the run checked out.
      merge_sha: inspected.mergeSha,
    },
    report_generated_at: inspected.reportGeneratedAt,
    files: { archive: "artifact.zip" },
  };
}

function githubToken() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) return token;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "A GitHub token is required: set GITHUB_TOKEN or GH_TOKEN, or run `gh auth login`.",
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      repo: { type: "string", default: "vercel/eve" },
      branch: { type: "string", default: "changeset-release/main" },
    },
  });
  const dryRun = values["dry-run"];
  const { repo, branch } = values;
  const token = githubToken();
  let store;
  if (!dryRun) {
    const blobToken = process.env.EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN;
    if (!blobToken)
      throw new Error(
        "EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN is required to mirror; pass --dry-run to only inspect.",
      );
    store = await vercelBlobStore(blobToken);
  }

  const artifacts = await listArtifacts({ repo, branch, token });
  console.error(`Found ${artifacts.length} unexpired ${ARTIFACT_NAME} artifacts on ${branch}.`);
  const counts = { mirrored: 0, skipped: 0, failed: 0 };
  for (const artifact of artifacts) {
    const prefix = `${PREFIX}/${artifact.workflow_run.id}/${artifact.id}`;
    const label = `${artifact.created_at} run ${artifact.workflow_run.id} artifact ${artifact.id}`;
    try {
      if (store !== undefined && (await store.read(`${prefix}/metadata.json`)) !== null) {
        counts.skipped += 1;
        console.error(`${label}: already mirrored`);
        continue;
      }
      const { archive, sha256 } = await downloadArchive(artifact, token);
      const inspected = inspectArchive(archive);
      const metadata = metadataFor({ repo, artifact, sha256, archive, inspected });
      if (store !== undefined) {
        await putImmutable(store, `${prefix}/artifact.zip`, archive, "application/zip");
        await putImmutable(
          store,
          `${prefix}/metadata.json`,
          Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`),
          "application/json",
        );
      }
      counts.mirrored += 1;
      console.error(
        `${label}: ${dryRun ? "would mirror" : "mirrored"} eve ${metadata.eve_version} (${archive.length} bytes)`,
      );
    } catch (error) {
      counts.failed += 1;
      console.error(`${label}: failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.error(
    `${dryRun ? "Would mirror" : "Mirrored"} ${counts.mirrored}, skipped ${counts.skipped}, failed ${counts.failed}.`,
  );
  if (counts.failed > 0) process.exitCode = 1;
}
