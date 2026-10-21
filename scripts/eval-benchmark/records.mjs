// Derives records.jsonl from the run legs' uploaded artifacts. Each leg
// artifact (downloaded to <legs-dir>/benchmark-leg-<leg_id>/) holds:
//
//   meta.json      { leg_id, sha, runner_os } written by the run job
//   expected.json  `eve eval --list --json` under the leg's tag filters
//   run/           the leg's single `.eve/evals/<timestamp>` tree
//
// Each record is one attempt of one eval on one model and world, keyed by
// (github_run_id, run_attempt, fixture, eval_id, model_id, world, attempt).
// Results are comparable across runs when (eval_id, fixture_digest, model_id,
// model_release, world) match. Planned legs that uploaded nothing, and expected
// evals with no result, become `missing` records so coverage stays honest.
// Richer measurements can be derived later from the published raw trees.
//
// A live leg's eval whose model steps all ran on another model (fixtures script
// some delegation evals with eve's mock models) says nothing about the leg's
// model, so it is excluded; the mock track still measures it.
//
// Usage: node scripts/eval-benchmark/records.mjs <plan.json> <legs-dir> <records.jsonl>
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const RECORD_SCHEMA_VERSION = 1;
export const LEG_ARTIFACT_PREFIX = "benchmark-leg-";

/** Map downloaded leg directories onto planned legs, rejecting anything unplanned. */
export function readLegs(plan, legsDir) {
  const planned = new Map(plan.legs.map((leg) => [leg.leg_id, leg]));
  const found = new Map();
  const entries = existsSync(legsDir) ? readdirSync(legsDir, { withFileTypes: true }) : [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(LEG_ARTIFACT_PREFIX))
      throw new Error(
        `Unexpected entry "${entry.name}" in ${legsDir}; expected ${LEG_ARTIFACT_PREFIX}<leg_id> directories.`,
      );
    const dir = join(legsDir, entry.name);
    const metaPath = join(dir, "meta.json");
    if (!existsSync(metaPath)) throw new Error(`${dir} has no meta.json.`);
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    if (`${LEG_ARTIFACT_PREFIX}${meta.leg_id}` !== entry.name)
      throw new Error(`${metaPath}: leg_id "${meta.leg_id}" does not match its artifact name.`);
    if (!planned.has(meta.leg_id))
      throw new Error(`${metaPath}: leg "${meta.leg_id}" was not planned.`);
    if (meta.sha !== plan.sha)
      throw new Error(`${metaPath}: ran at ${meta.sha}, but the plan is for ${plan.sha}.`);
    const expectedPath = join(dir, "expected.json");
    found.set(meta.leg_id, {
      dir,
      meta,
      expected: existsSync(expectedPath)
        ? JSON.parse(readFileSync(expectedPath, "utf8")).map((entry) => entry.id)
        : undefined,
    });
  }
  return plan.legs.map((leg) => ({ leg, ...found.get(leg.leg_id) }));
}

/** Path of a leg's raw tree, relative to the run's Blob prefix. */
export function legArtifactPath(leg) {
  return `raw/${leg.fixture}/${leg.model_name}/${leg.world}/${leg.attempt}`;
}

/**
 * @param {{
 *   plan: any,
 *   legs: ReturnType<typeof readLegs>,
 *   githubRunId: string,
 *   runAttempt: number,
 * }} input
 */
export function buildRecords({ plan, legs, githubRunId, runAttempt }) {
  const excluded = [];
  const fixtures = new Map(plan.registry.fixtures.map((fixture) => [fixture.name, fixture]));
  const releases = new Map(plan.registry.models.map((model) => [model.id, model.release]));
  const attempts = [];
  for (const { leg, dir, meta, expected } of legs) {
    const fixture = fixtures.get(leg.fixture);
    const artifacts = dir === undefined ? [] : listEvalArtifacts(join(dir, "run"));
    const results = new Map(
      artifacts.map((path) => {
        const artifact = JSON.parse(readFileSync(path, "utf8"));
        return [artifact.id, artifact];
      }),
    );
    const missingReason = dir === undefined ? "job-missing" : "eval-missing";
    const expectedIds = expected ?? fixture.eval_ids;
    for (const evalId of new Set([...expectedIds, ...results.keys()])) {
      const artifact = results.get(evalId);
      if (leg.kind === "live" && artifact !== undefined && !ranOnModel(artifact, leg.model_id)) {
        excluded.push({ leg_id: leg.leg_id, eval_id: evalId });
        continue;
      }
      attempts.push({
        leg,
        meta,
        evalId,
        artifact,
        missingReason,
        uploaded: dir !== undefined,
      });
    }
  }

  const records = attempts.map(({ leg, meta, evalId, artifact, missingReason, uploaded }) => {
    const startedAt = artifact?.startedAt ?? null;
    const completedAt = artifact?.completedAt ?? null;
    return {
      schema_version: RECORD_SCHEMA_VERSION,
      github_run_id: String(githubRunId),
      run_attempt: runAttempt,
      fixture: leg.fixture,
      eval_id: evalId,
      model_id: leg.model_id,
      model_slot: leg.model_name,
      model_release: leg.kind === "mock" ? null : (releases.get(leg.model_id) ?? null),
      world: leg.world,
      attempt: leg.attempt,
      fixture_digest: fixtures.get(leg.fixture).digest,
      sha: plan.sha,
      eve_version: artifact?.result?.runtimeIdentity?.eveVersion ?? null,
      runner_os: meta?.runner_os ?? null,
      missing: artifact === undefined ? missingReason : null,
      verdict: artifact?.verdict ?? null,
      assertions: (artifact?.assertions ?? []).map(({ name, severity, score, passed }) => ({
        name,
        severity,
        score,
        passed,
      })),
      error: artifact?.error ?? null,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms:
        startedAt !== null && completedAt !== null
          ? Date.parse(completedAt) - Date.parse(startedAt)
          : null,
      artifact_path: uploaded ? legArtifactPath(leg) : null,
    };
  });
  return { records, excluded };
}

/**
 * False only when the eval made model calls and none used `modelId`. An eval
 * that never reached a model step stays, so its failure is recorded.
 */
function ranOnModel(artifact, modelId) {
  const models = artifact.result?.derived?.models ?? [];
  return models.length === 0 || models.includes(modelId);
}

/** Find every eval detail artifact under one `.eve/evals/<timestamp>` tree. */
export function listEvalArtifacts(runDirectory) {
  const evalsDirectory = join(runDirectory, "evals");
  if (!existsSync(evalsDirectory)) return [];
  return readdirSync(evalsDirectory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [planPath, legsDir, outPath] = process.argv.slice(2);
  if (outPath === undefined) {
    console.error(
      "Usage: node scripts/eval-benchmark/records.mjs <plan.json> <legs-dir> <records.jsonl>",
    );
    process.exit(1);
  }
  const githubRunId = process.env.GITHUB_RUN_ID;
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT ?? "1");
  if (githubRunId === undefined)
    throw new Error("GITHUB_RUN_ID is required to key benchmark records.");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const { records, excluded } = buildRecords({
    plan,
    legs: readLegs(plan, legsDir),
    githubRunId,
    runAttempt,
  });
  writeFileSync(outPath, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  const missing = records.filter((record) => record.missing !== null).length;
  console.error(`Wrote ${records.length} records (${missing} missing) to ${outPath}.`);
  if (excluded.length > 0) {
    console.error(
      `Excluded ${excluded.length} live-leg evals whose model steps never used the leg's model:`,
    );
    for (const { leg_id, eval_id } of excluded) console.error(`  ${leg_id} ${eval_id}`);
  }
}
