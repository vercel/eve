// Derives benchmark runs from the release-PR stress archives that
// mirror-stress-artifacts.mjs copied to Blob, so the eval viewer can trend
// hosted `agent-workflow-stress` back to releases the benchmark never ran.
//
// Each release keeps one archive: from a run on a merged release PR's final
// head commit (the latest attempt, if several uploaded). That
// build is the published release; earlier pushes of the PR are not. Each
// becomes one run with a single mock leg (`agent-workflow-stress` on the
// `vercel` world, like the benchmark's hosted legs), derived with the
// benchmark's own records code:
//
//   imports/metrics-v<METRICS_VERSION>/runs/<github_run_id>/<run_attempt>/...
//
// The run keeps the source run's id and attempt, the measurement's own time
// (`planned_at`), and the release merge commit (`sha`, and the fixture digest
// there); the manifest's `source` names the archive. A build whose measured
// merge ref has a different tree from the release merge commit is rejected,
// since main moved before the release merged. Published runs are immutable,
// so re-runs skip them; a metrics version change derives every release again
// under a new root.
//
// e2e-vercel uploads the archive only when the run succeeded, so imported
// runs carry no failed attempts and their reliability metrics are not
// comparable with the benchmark's own runs.
//
// Usage: node scripts/eval-benchmark/import-stress-artifacts.mjs [--dry-run] [--repo vercel/eve] [--branch changeset-release/main]
// Requires EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN (read even with --dry-run), a
// GitHub token (GITHUB_TOKEN, GH_TOKEN, or `gh auth login`), and the release
// merge commits in the local git history.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { METRICS_VERSION } from "../eval-metrics/standard.mjs";
import { fixtureDigest } from "./digest.mjs";
import { publishRun, vercelBlobStore } from "./publish.mjs";
import { LEG_ARTIFACT_PREFIX, buildRecords, readLegs } from "./records.mjs";

const MIRROR_PREFIX = "imports/workflow-stress";
const ROOT = `imports/metrics-v${METRICS_VERSION}/runs`;
const FIXTURE = "agent-workflow-stress";
const FIXTURE_DIR = `e2e/fixtures/${FIXTURE}`;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_PULL_PAGES = 20;

/**
 * The release build among mirrored archives: per merged release PR, the
 * archive from a run on its final head commit (the latest attempt).
 *
 * @param {any[]} mirrored metadata.json of each mirrored archive
 * @param {Map<string, { number: number, merge_commit_sha: string }>} mergedByHead merged release PRs by final head commit
 */
export function selectReleaseBuilds(mirrored, mergedByHead) {
  const byPull = new Map();
  for (const metadata of mirrored) {
    const pull = mergedByHead.get(metadata.workflow_run.head_sha);
    if (pull === undefined || !Number.isInteger(metadata.workflow_run.attempt)) continue;
    const chosen = byPull.get(pull.number);
    if (
      chosen === undefined ||
      metadata.workflow_run.attempt > chosen.metadata.workflow_run.attempt
    )
      byPull.set(pull.number, { metadata, pull });
  }
  return [...byPull.values()].sort((a, b) =>
    a.metadata.artifact.created_at.localeCompare(b.metadata.artifact.created_at),
  );
}

/** The fixture's eval ids at a commit, as `eve eval --list` names them. */
function evalIdsAt(sha) {
  const evalsDir = `${FIXTURE_DIR}/evals/`;
  return execFileSync("git", ["ls-tree", "-r", "--name-only", sha, evalsDir], { encoding: "utf8" })
    .split("\n")
    .filter((path) => path.endsWith(".eval.ts"))
    .map((path) => path.slice(evalsDir.length, -".eval.ts".length))
    .sort();
}

/**
 * Why the run did not measure the release merge commit's code, if it did not.
 * The run checked out its pull_request merge ref; if main moved before the
 * release merged, the release labels would name code the run never ran.
 *
 * GitHub deletes a merge ref when its PR merges, and git cannot fetch a
 * commit no ref reaches, so the measured tree comes from the API, which keeps
 * the commit. Every metrics version re-derives every release, long after its
 * merge, so this check must not depend on the ref.
 */
async function measurementMismatch({ measuredSha, sha, repo, token }) {
  if (!measuredSha) return "the archive does not name the commit it measured";
  const measured = await github(`/repos/${repo}/git/commits/${measuredSha}`, token, {
    optional: true,
  });
  if (measured === null) return `the measured commit ${measuredSha} no longer exists`;
  const releaseTree = execFileSync("git", ["rev-parse", `${sha}^{tree}`], {
    encoding: "utf8",
  }).trim();
  if (measured.tree.sha !== releaseTree)
    return `the measured commit ${measuredSha} and the release merge commit ${sha} have different trees`;
  return undefined;
}

/** Lays out one archive as the benchmark's downloaded leg directory. */
function stageLeg({ archive, legsDir, leg, sha, evalIds }) {
  const extracted = mkdtempSync(join(tmpdir(), "eve-stress-import-"));
  try {
    const zip = join(extracted, "artifact.zip");
    writeFileSync(zip, archive);
    execFileSync("unzip", ["-q", zip, "-d", join(extracted, "files")], {
      maxBuffer: MAX_ARCHIVE_BYTES,
    });
    const evalsDir = join(extracted, "files", FIXTURE_DIR, ".eve", "evals");
    const runs = readdirSync(evalsDir);
    if (runs.length !== 1)
      throw new Error(`Expected one .eve/evals run in the archive, found ${runs.length}.`);
    const dir = join(legsDir, `${LEG_ARTIFACT_PREFIX}${leg.leg_id}`);
    mkdirSync(dir, { recursive: true });
    cpSync(join(evalsDir, runs[0]), join(dir, "run"), { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ leg_id: leg.leg_id, sha, runner_os: "Linux" }),
    );
    writeFileSync(join(dir, "expected.json"), JSON.stringify(evalIds.map((id) => ({ id }))));
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}

/** The plan the benchmark would have written for this one hosted mock leg. */
function planFor({ metadata, sha, evalIds }) {
  const leg = {
    leg_id: `mock__${FIXTURE}__mock__vercel__1`,
    kind: "mock",
    fixture: FIXTURE,
    dir: FIXTURE_DIR,
    model_name: "mock",
    model_id: "mock",
    world: "vercel",
    world_package: "",
    hosted: true,
    attempt: 1,
  };
  return {
    schema_version: 1,
    sha,
    planned_at: metadata.report_generated_at ?? metadata.artifact.created_at,
    registry: {
      attempts: 1,
      mock_attempts: 1,
      // e2e-vercel ran one leg, at the fixture's own maxConcurrency of 1.
      concurrency: { legs: 1, evals_per_leg: 1 },
      models: [],
      mock_worlds: ["vercel"],
      mock_fixtures: [FIXTURE],
      fixtures: [
        {
          name: FIXTURE,
          dir: FIXTURE_DIR,
          digest: fixtureDigest(sha, FIXTURE_DIR),
          eval_ids: evalIds,
        },
      ],
    },
    legs: [leg],
  };
}

/** `optional` returns null for a resource GitHub does not have, instead of failing. */
async function github(path, token, { optional = false } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (optional && response.status === 404) return null;
  if (!response.ok)
    throw new Error(`GET ${path} failed: ${response.status} ${response.statusText}`);
  return response.json();
}

/**
 * Merged release PRs by their final head commit. The release branch is reused
 * for every release, and a run's `pull_requests` names the PR open on it now,
 * so archives are matched to releases by head commit instead.
 */
async function mergedReleasePulls({ repo, branch, token }) {
  const owner = repo.split("/")[0];
  const byHead = new Map();
  for (let page = 1; page <= MAX_PULL_PAGES; page += 1) {
    const pulls = await github(
      `/repos/${repo}/pulls?state=closed&head=${owner}:${branch}&per_page=100&page=${page}`,
      token,
    );
    for (const pull of pulls) if (pull.merged_at) byHead.set(pull.head.sha, pull);
    if (pulls.length < 100) return byHead;
  }
  throw new Error(`More than ${MAX_PULL_PAGES} pages of ${branch} pull requests.`);
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
  const blobToken = process.env.EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN;
  if (!blobToken)
    throw new Error(
      "EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN is required to read the mirrored archives.",
    );
  const store = await vercelBlobStore(blobToken);
  const token = githubToken();

  const metadataPaths = (await store.list(`${MIRROR_PREFIX}/`)).filter((path) =>
    path.endsWith("/metadata.json"),
  );
  const mirrored = await Promise.all(
    metadataPaths.map(async (path) => ({ ...JSON.parse(await store.read(path)), path })),
  );
  const builds = selectReleaseBuilds(mirrored, await mergedReleasePulls({ repo, branch, token }));
  console.error(
    `${mirrored.length} mirrored archives; ${builds.length} are release builds of a merged PR's final head.`,
  );

  const counts = { imported: 0, skipped: 0, rejected: 0, failed: 0 };
  for (const { metadata, pull } of builds) {
    const { id: runId, attempt } = metadata.workflow_run;
    const label = `eve ${metadata.eve_version} (PR #${pull.number}, run ${runId}/${attempt})`;
    const legsDir = mkdtempSync(join(tmpdir(), "eve-stress-legs-"));
    try {
      if ((await store.read(`${ROOT}/${runId}/${attempt}/manifest.json`)) !== null) {
        counts.skipped += 1;
        console.error(`${label}: already imported`);
        continue;
      }
      const sha = pull.merge_commit_sha;
      const mismatch = await measurementMismatch({
        measuredSha: metadata.workflow_run.merge_sha,
        sha,
        repo,
        token,
      });
      if (mismatch !== undefined) {
        counts.rejected += 1;
        console.error(`${label}: rejected: ${mismatch}`);
        continue;
      }
      const evalIds = evalIdsAt(sha);
      const plan = planFor({ metadata, sha, evalIds });
      const archive = await store.read(
        metadata.path.replace(/metadata\.json$/, metadata.files.archive),
      );
      if (archive === null) throw new Error(`${metadata.path} has no archive next to it.`);
      stageLeg({ archive, legsDir, leg: plan.legs[0], sha, evalIds });
      const legs = readLegs(plan, legsDir);
      const { records } = buildRecords({
        plan,
        legs,
        githubRunId: String(runId),
        runAttempt: attempt,
      });
      const outcomes = records.map(
        (record) => `${record.eval_id}=${record.verdict ?? record.missing}`,
      );
      if (!dryRun) {
        await publishRun({
          plan,
          legs,
          recordsJsonl: records.map((record) => `${JSON.stringify(record)}\n`).join(""),
          // e2e-vercel ran no build, start, or dev-startup probes.
          frameworkRecordsJsonl: "",
          githubRunId: String(runId),
          runAttempt: attempt,
          eveVersion: metadata.eve_version,
          store,
          root: ROOT,
          source: {
            kind: "e2e-vercel-release-pr",
            repository: repo,
            pull_request: pull.number,
            archive: metadata.path.replace(/metadata\.json$/, metadata.files.archive),
            artifact_sha256: metadata.artifact.sha256,
            head_sha: metadata.workflow_run.head_sha,
          },
        });
      }
      counts.imported += 1;
      console.error(`${label}: ${dryRun ? "would import" : "imported"} ${outcomes.join(" ")}`);
    } catch (error) {
      counts.failed += 1;
      console.error(`${label}: failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      rmSync(legsDir, { recursive: true, force: true });
    }
  }
  console.error(
    `${dryRun ? "Would import" : "Imported"} ${counts.imported}, skipped ${counts.skipped}, rejected ${counts.rejected}, failed ${counts.failed}.`,
  );
  if (counts.failed > 0) process.exitCode = 1;
}
