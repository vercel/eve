// Derives framework-records.jsonl: run-level framework metrics that belong to
// a commit and a fixture, not to an eval attempt. Each record is one probe
// sample, keyed by (github_run_id, run_attempt, probe, subject, world,
// attempt), and comparable across runs when (probe, subject, subject_digest,
// world, runner_os, cold) match. Records carry no model fields.
//
// `subject_digest` identifies what was measured: the fixture digest for a
// fixture, or the startup script's blob id for an agent it generates. `cold`
// marks a sample from an empty project: every mock-leg probe (a fresh runner)
// and run 1 of each dev-startup agent. One-time setup, such as preparing
// sandbox images, lands there, so warm and cold samples never pool.
//
//   build        `eve build --profile` on mock legs with a production server
//                (leg probes/build-profile.json), and the dev-startup job's
//                builds of its benchmark agents
//   start        `eve start` → first `/eve/v1/health` 200 on the same legs
//                (leg probes/start.json: { readyMs }), and on the
//                dev-startup job's builds of its benchmark agents
//   dev-startup  `eve dev` ready, then a first turn accepted and completed, from
//                packages/eve/scripts/benchmark-startup.mjs
//                (<dev-startup-dir>/<subject>.jsonl: its stdout)
//
// A planned probe without data is a `missing` record, as in records.jsonl.
//
// Usage: node scripts/eval-benchmark/framework-records.mjs <plan.json> <legs-dir> <dev-startup-dir> <framework-records.jsonl>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readBuildProfile } from "../build-profile-report.mjs";
import { legArtifactPath, readLegs } from "./records.mjs";

export const FRAMEWORK_RECORD_SCHEMA_VERSION = 1;
export const DEV_STARTUP_ARTIFACT_PATH = "raw/dev-startup";

const framework = (unit) => ({ unit, direction: "lower", scope: "framework", pooled: false });

/** Every run-level metric; `*` stands for a build phase name. */
export const FRAMEWORK_RECORD_METRICS = Object.freeze({
  "build.total_ms": framework("ms"),
  "build.phase_ms.*": framework("ms"),
  // Sandbox preparation depends mostly on the runner and network, and
  // dominates cold builds; this is the rest of the build.
  "build.without_sandbox_prewarm_ms": framework("ms"),
  "start.ready_ms": framework("ms"),
  "dev_startup.ready_ms": framework("ms"),
  "dev_startup.session_accepted_ms": framework("ms"),
  "dev_startup.first_turn_ms": framework("ms"),
});

/** Legs that build and start a local production server, and so carry build and start probes. */
export function probedLegs(legs) {
  return legs.filter(({ leg }) => leg.kind === "mock" && leg.world !== "local" && !leg.hosted);
}

/**
 * @param {{
 *   plan: any,
 *   legs: ReturnType<typeof readLegs>,
 *   devStartupDir: string | undefined,
 *   githubRunId: string,
 *   runAttempt: number,
 * }} input
 */
export function buildFrameworkRecords({ plan, legs, devStartupDir, githubRunId, runAttempt }) {
  const record = ({
    probe,
    subject,
    subjectDigest,
    world,
    attempt,
    cold,
    runnerOs,
    missing,
    metrics,
    path,
  }) => ({
    schema_version: FRAMEWORK_RECORD_SCHEMA_VERSION,
    github_run_id: String(githubRunId),
    run_attempt: runAttempt,
    probe,
    subject,
    subject_digest: subjectDigest ?? null,
    world,
    attempt,
    cold,
    sha: plan.sha,
    runner_os: runnerOs ?? null,
    missing: missing ?? null,
    metrics: metrics ?? {},
    artifact_path: path ?? null,
  });

  const digests = new Map(plan.registry.fixtures.map((fixture) => [fixture.name, fixture.digest]));
  const records = [];
  for (const { leg, dir, meta } of probedLegs(legs)) {
    const base = {
      subject: leg.fixture,
      subjectDigest: digests.get(leg.fixture),
      world: leg.world,
      attempt: leg.attempt,
      cold: true,
    };
    const runnerOs = meta?.runner_os;
    const path = dir === undefined ? undefined : legArtifactPath(leg);
    const read = (name) => {
      const file = dir === undefined ? undefined : join(dir, "probes", name);
      return file !== undefined && existsSync(file)
        ? JSON.parse(readFileSync(file, "utf8"))
        : undefined;
    };
    const missing = (probe) =>
      record({
        ...base,
        probe,
        runnerOs,
        missing: dir === undefined ? "job-missing" : "probe-missing",
      });

    const profile = read("build-profile.json");
    records.push(
      profile === undefined
        ? missing("build")
        : record({ ...base, probe: "build", runnerOs, path, metrics: buildMetrics(profile) }),
    );
    const start = read("start.json");
    records.push(
      start === undefined
        ? missing("start")
        : record({
            ...base,
            probe: "start",
            runnerOs,
            path,
            metrics: { "start.ready_ms": duration(start.readyMs) },
          }),
    );
  }

  const devStartup = plan.registry.dev_startup;
  if (devStartup) {
    const meta = readOptionalJson(devStartupDir && join(devStartupDir, "meta.json"));
    if (meta !== undefined && meta.sha !== plan.sha)
      throw new Error(`dev-startup ran at ${meta.sha}, but the plan is for ${plan.sha}.`);
    for (const { name, digest } of devStartup.subjects) {
      const lines = readJsonLines(devStartupDir && join(devStartupDir, `${name}.jsonl`));
      for (let run = 1; run <= devStartup.runs; run += 1) {
        const base = {
          subject: name,
          subjectDigest: digest,
          world: "local",
          attempt: run,
          cold: run === 1,
          runnerOs: meta?.runner_os,
        };
        const missingReason =
          meta === undefined
            ? "job-missing"
            : lines === undefined
              ? "probe-missing"
              : "run-missing";
        const dev = lines?.find((line) => line.mode === "dev" && line.run === run);
        records.push(
          dev === undefined
            ? record({ ...base, probe: "dev-startup", missing: missingReason })
            : record({
                ...base,
                probe: "dev-startup",
                path: DEV_STARTUP_ARTIFACT_PATH,
                metrics: {
                  "dev_startup.ready_ms": duration(dev.wallMs),
                  "dev_startup.session_accepted_ms": duration(dev.sessionAcceptedMs),
                  "dev_startup.first_turn_ms": duration(dev.firstTurnMs),
                },
              }),
        );
        const build = lines?.find((line) => line.mode === "build" && line.run === run);
        records.push(
          build === undefined
            ? record({ ...base, probe: "build", missing: missingReason })
            : record({
                ...base,
                probe: "build",
                path: DEV_STARTUP_ARTIFACT_PATH,
                metrics: buildMetrics(build.profile),
              }),
        );
        // `eve start` on the build above, to /eve/v1/health (same metric as
        // the mock legs' start probe, on a fixed agent instead of a fixture).
        const start = lines?.find((line) => line.mode === "start" && line.run === run);
        records.push(
          start === undefined
            ? record({ ...base, probe: "start", missing: missingReason })
            : record({
                ...base,
                probe: "start",
                path: DEV_STARTUP_ARTIFACT_PATH,
                metrics: { "start.ready_ms": duration(start.wallMs) },
              }),
        );
      }
    }
  }
  return records;
}

function buildMetrics(value) {
  let profile;
  try {
    profile = readBuildProfile(value, "build profile");
  } catch {
    const invalid = { status: "unavailable", reason: "invalid-build-profile" };
    return { "build.total_ms": invalid, "build.without_sandbox_prewarm_ms": invalid };
  }
  const prewarm = profile.phases.find((phase) => phase.name === "sandbox.prewarm");
  return {
    "build.total_ms": duration(profile.durationMs),
    "build.without_sandbox_prewarm_ms": duration(profile.durationMs - (prewarm?.durationMs ?? 0)),
    ...Object.fromEntries(
      profile.phases.map((phase) => [`build.phase_ms.${phase.name}`, duration(phase.durationMs)]),
    ),
  };
}

function duration(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? { status: "measured", value }
    : { status: "unavailable", reason: "missing-duration" };
}

function readOptionalJson(path) {
  return path !== undefined && existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : undefined;
}

/** benchmark-startup.mjs prints one JSON object per line; only result lines carry `run`. */
function readJsonLines(path) {
  if (path === undefined || !existsSync(path)) return undefined;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter((line) => Number.isInteger(line.run));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [planPath, legsDir, devStartupDir, outPath] = process.argv.slice(2);
  if (outPath === undefined) {
    console.error(
      "Usage: node scripts/eval-benchmark/framework-records.mjs <plan.json> <legs-dir> <dev-startup-dir> <framework-records.jsonl>",
    );
    process.exit(1);
  }
  const githubRunId = process.env.GITHUB_RUN_ID;
  if (githubRunId === undefined)
    throw new Error("GITHUB_RUN_ID is required to key benchmark records.");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const records = buildFrameworkRecords({
    plan,
    legs: readLegs(plan, legsDir),
    devStartupDir,
    githubRunId,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? "1"),
  });
  writeFileSync(outPath, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  const missing = records.filter((record) => record.missing !== null).length;
  console.error(`Wrote ${records.length} framework records (${missing} missing) to ${outPath}.`);
}
