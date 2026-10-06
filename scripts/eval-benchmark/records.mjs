// Derives records.jsonl from the run legs' uploaded artifacts. Each leg
// artifact (downloaded to <legs-dir>/benchmark-leg-<leg_id>/) holds:
//
//   meta.json      { leg_id, sha, runner_os } written by the run job
//   expected.json  `eve eval --list --json` under the leg's tag filters
//   run/           the leg's single `.eve/evals/<timestamp>` tree
//
// Planned legs that uploaded nothing, and expected evals with no result,
// become `gap` records so coverage stays honest. A live leg's eval whose model
// steps all ran on another model (fixtures script some delegation evals with
// eve's mock models) says nothing about the leg's model, so it is excluded;
// the mock track still measures it.
//
// Usage: node scripts/eval-benchmark/records.mjs <plan.json> <legs-dir> <records.jsonl>
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyOutcome } from "../eval-metrics/gaps.mjs";
import {
  METRICS_VERSION,
  deriveAttemptMetrics,
  listEvalArtifacts,
} from "../eval-metrics/standard.mjs";
import { evalDigests } from "./digest.mjs";
import { validate } from "./schema.mjs";

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
 *   digestFor: (fixture: { name: string, dir: string }, evalIds: string[]) => Map<string, string>,
 * }} input
 */
export function buildRecords({ plan, legs, githubRunId, runAttempt, digestFor }) {
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

  const digests = new Map();
  for (const fixture of plan.registry.fixtures) {
    const ids = [
      ...new Set(attempts.filter((a) => a.leg.fixture === fixture.name).map((a) => a.evalId)),
    ];
    for (const [id, digest] of digestFor(fixture, ids))
      digests.set(`${fixture.name}\0${id}`, digest);
  }

  const records = attempts.map(({ leg, meta, evalId, artifact, missingReason, uploaded }) => {
    const base = {
      schema_version: RECORD_SCHEMA_VERSION,
      github_run_id: String(githubRunId),
      run_attempt: runAttempt,
      fixture: leg.fixture,
      eval_id: evalId,
      model_id: leg.model_id,
      model_slot: leg.model_name,
      world: leg.world,
      attempt: leg.attempt,
      eval_digest: digests.get(`${leg.fixture}\0${evalId}`),
      model_release: leg.kind === "mock" ? null : (releases.get(leg.model_id) ?? null),
      judge_model: plan.registry.judge,
      sha: plan.sha,
      runner_os: meta?.runner_os ?? null,
      artifact_path: uploaded ? legArtifactPath(leg) : null,
    };
    if (artifact === undefined) {
      return {
        ...base,
        eve_version: null,
        started_at: null,
        verdict: null,
        assertions: [],
        outcome: "gap",
        gap_reason: missingReason,
        metrics_version: METRICS_VERSION,
        metrics: {},
        failures: [],
        bundles: {},
      };
    }
    const { outcome, gap_reason } = classifyOutcome(artifact);
    const { metrics_version, metrics, failures } = deriveAttemptMetrics(artifact);
    return {
      ...base,
      eve_version: artifact.result?.runtimeIdentity?.eveVersion ?? null,
      started_at: artifact.startedAt ?? null,
      verdict: artifact.verdict ?? null,
      assertions: (artifact.assertions ?? []).map(({ name, severity, score, passed }) => ({
        name,
        severity,
        score,
        passed,
      })),
      outcome,
      gap_reason: gap_reason ?? null,
      metrics_version,
      metrics,
      failures,
      bundles: {},
    };
  });
  return { records, excluded };
}

/**
 * False only when the eval made model calls and none used `modelId`. An eval
 * that never reached a model step stays, so it can surface as a gap.
 */
function ranOnModel(artifact, modelId) {
  const models = (artifact.result?.sessions ?? []).flatMap((session) =>
    (session.events ?? []).filter((e) => e.type === "step.started").map((e) => e.data?.modelId),
  );
  return models.length === 0 || models.includes(modelId);
}

/** Throw with every schema violation, naming the offending record. */
export function assertValidRecords(records) {
  const problems = records.flatMap((record, index) =>
    validate(record).map(
      (error) =>
        `record ${index} (${record?.fixture}/${record?.eval_id}, ${record?.model_id}): ${error}`,
    ),
  );
  if (problems.length > 0)
    throw new Error(`Invalid benchmark records:\n${problems.slice(0, 50).join("\n")}`);
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
    digestFor: (fixture, evalIds) =>
      evalDigests({ sha: plan.sha, fixtureDir: fixture.dir, evalIds }),
  });
  assertValidRecords(records);
  writeFileSync(outPath, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  const gaps = records.filter((record) => record.outcome === "gap").length;
  console.error(`Wrote ${records.length} records (${gaps} gaps) to ${outPath}.`);
  if (excluded.length > 0) {
    console.error(
      `Excluded ${excluded.length} live-leg evals whose model steps never used the leg's model:`,
    );
    for (const { leg_id, eval_id } of excluded) console.error(`  ${leg_id} ${eval_id}`);
  }
}
