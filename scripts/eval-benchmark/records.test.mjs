import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFrameworkRecords } from "./framework-records.mjs";
import { publishRun } from "./publish.mjs";
import { METRICS_VERSION, STANDARD_METRICS } from "../eval-metrics/standard.mjs";
import { buildRecords, readLegs } from "./records.mjs";

const SHA = "a".repeat(40);
const plan = {
  schema_version: 1,
  sha: SHA,
  planned_at: "2026-01-01T00:00:00.000Z",
  registry: {
    attempts: 1,
    mock_attempts: 1,
    dev_startup: { runs: 2, subjects: [{ name: "minimal", tools: 0, digest: "b".repeat(40) }] },
    models: [{ name: "alpha", id: "acme/alpha", release: "2026-09-22" }],
    mock_worlds: ["local"],
    fixtures: [
      {
        name: "agent-tools",
        dir: "e2e/fixtures/agent-tools",
        digest: "f".repeat(64),
        eval_ids: ["static-tools/ends-turn-function", "static-tools/no-reply"],
      },
    ],
  },
  legs: [
    {
      leg_id: "live__agent-tools__alpha__local__1",
      kind: "live",
      fixture: "agent-tools",
      dir: "e2e/fixtures/agent-tools",
      model_name: "alpha",
      model_id: "acme/alpha",
      world: "local",
      world_package: "",
      attempt: 1,
    },
    {
      leg_id: "mock__agent-tools__mock__local__1",
      kind: "mock",
      fixture: "agent-tools",
      dir: "e2e/fixtures/agent-tools",
      model_name: "mock",
      model_id: "mock",
      world: "local",
      world_package: "",
      attempt: 1,
    },
    {
      leg_id: "mock__agent-tools__mock__postgres__1",
      kind: "mock",
      fixture: "agent-tools",
      dir: "e2e/fixtures/agent-tools",
      model_name: "mock",
      model_id: "mock",
      world: "postgres",
      world_package: "@workflow/world-postgres",
      attempt: 1,
    },
  ],
};

/** One uploaded live leg whose run produced one of its two expected evals; the mock leg is missing. */
function legsDirectory(t, meta = {}) {
  const root = mkdtempSync(join(tmpdir(), "eve-benchmark-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const leg = join(root, "benchmark-leg-live__agent-tools__alpha__local__1");
  mkdirSync(join(leg, "run", "evals", "static-tools"), { recursive: true });
  writeFileSync(
    join(leg, "meta.json"),
    JSON.stringify({
      leg_id: "live__agent-tools__alpha__local__1",
      sha: SHA,
      runner_os: "Linux",
      ...meta,
    }),
  );
  writeEval(leg, "static-tools/ends-turn-function", "acme/alpha");
  writeFileSync(join(leg, "run", "summary.json"), "{}");
  return root;
}

function writeEval(leg, evalId, modelId) {
  const artifact = {
    id: evalId,
    verdict: "passed",
    assertions: [{ name: "replied", severity: "gate", score: 1, passed: true, extra: "x" }],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.500Z",
    result: {
      runtimeIdentity: { eveVersion: "0.71.2" },
      derived: { models: [modelId] },
    },
  };
  writeFileSync(join(leg, "run", "evals", `${evalId}.json`), JSON.stringify(artifact));
}

const build = (legsDir) => buildWithExclusions(legsDir).records;
const buildWithExclusions = (legsDir) =>
  buildRecords({
    plan,
    legs: readLegs(plan, legsDir),
    githubRunId: "123",
    runAttempt: 1,
  });

test("builds records and turns missing legs and evals into missing records", (t) => {
  const records = build(legsDirectory(t));
  assert.deepEqual(
    records.map((r) => [r.model_id, r.eval_id, r.missing, r.artifact_path]),
    [
      ["acme/alpha", "static-tools/ends-turn-function", null, "raw/agent-tools/alpha/local/1"],
      ["acme/alpha", "static-tools/no-reply", "eval-missing", "raw/agent-tools/alpha/local/1"],
      ["mock", "static-tools/ends-turn-function", "job-missing", null],
      ["mock", "static-tools/no-reply", "job-missing", null],
      ["mock", "static-tools/ends-turn-function", "job-missing", null],
      ["mock", "static-tools/no-reply", "job-missing", null],
    ],
  );
  assert.deepEqual(
    records.map((r) => r.model_class),
    ["live", "live", "mock", "mock", "mock", "mock"],
  );
  const [completed] = records;
  assert.equal(completed.eve_version, "0.71.2");
  assert.equal(completed.model_release, "2026-09-22");
  assert.equal(completed.verdict, "passed");
  assert.equal(completed.duration_ms, 1500);
  assert.deepEqual(completed.assertions, [
    { name: "replied", severity: "gate", score: 1, passed: true },
  ]);
  assert.equal(records[2].model_release, null);
  assert.equal(records[2].duration_ms, null);
  assert.equal(completed.outcome, "completed");
  assert.deepEqual(completed.metrics["latency.turn_ms"], {
    status: "unavailable",
    reason: "missing-session-capture",
  });
});

test("attaches metrics to captured attempts and marks missing attempts as gaps", (t) => {
  const legsDir = legsDirectory(t);
  // A real captured artifact, with session events, in place of the minimal one.
  copyFileSync(
    new URL("../eval-metrics/fixtures/agent-tools-ends-turn-function.json", import.meta.url),
    join(
      legsDir,
      "benchmark-leg-live__agent-tools__alpha__local__1",
      "run",
      "evals",
      "static-tools",
      "ends-turn-function.json",
    ),
  );
  const [captured, missingEval, missingJob] = build(legsDir);
  assert.equal(
    captured.metrics["durability.workflow_steps_per_turn"].reason,
    "missing-world-probe",
  );
  assert.equal(captured.outcome, "completed");
  assert.equal(captured.gap_reason, null);
  assert.equal(captured.metrics_version, METRICS_VERSION);
  assert.deepEqual(Object.keys(captured.metrics).sort(), Object.keys(STANDARD_METRICS).sort());
  assert.deepEqual(captured.metrics["tokens.input"], { status: "measured", value: 1117 });
  // The fixture's model reports no cost: unavailable with a reason, never zero.
  assert.deepEqual(captured.metrics["cost.total_usd"], {
    status: "unavailable",
    reason: "missing-rolled-up-cost",
  });
  assert.deepEqual(captured.failures, []);

  for (const [record, reason] of [
    [missingEval, "eval-missing"],
    [missingJob, "job-missing"],
  ]) {
    assert.equal(record.outcome, "gap");
    assert.equal(record.gap_reason, reason);
    assert.deepEqual(record.metrics, {});
    assert.deepEqual(record.failures, []);
  }
});

test("derives durable work from the leg's world probe", (t) => {
  const legsDir = legsDirectory(t);
  const leg = join(legsDir, "benchmark-leg-live__agent-tools__alpha__local__1");
  copyFileSync(
    new URL("../eval-metrics/fixtures/agent-tools-ends-turn-function.json", import.meta.url),
    join(leg, "run", "evals", "static-tools", "ends-turn-function.json"),
  );
  const runId = "wrun_01M476RTSJ569Y4TN0BBRB2ED0";
  const step = (n) => [
    { eventType: "step_created", payloadBytes: { input: 100 * n } },
    { eventType: "step_started", payloadBytes: {} },
    { eventType: "step_completed", payloadBytes: { result: 10 * n } },
  ];
  mkdirSync(join(leg, "world"));
  writeFileSync(
    join(leg, "world", `${runId}.json`),
    JSON.stringify({ runId, world: "local", events: [...step(1), ...step(2), ...step(3)] }),
  );
  const { metrics } = build(legsDir)[0];
  // Two turns and three model steps in the captured session.
  assert.equal(metrics["durability.workflow_steps_per_turn"].value, 1.5);
  assert.equal(metrics["durability.step_input_bytes_per_turn"].value, 300);
  assert.equal(metrics["durability.step_output_bytes_per_turn"].value, 30);
  assert.equal(metrics["durability.workflow_steps_per_model_step"].value, 1);

  writeFileSync(
    join(leg, "world", `${runId}.json`),
    JSON.stringify({
      runId,
      world: "local",
      events: [{ eventType: "step_created", payloadBytes: {} }],
    }),
  );
  assert.equal(
    build(legsDir)[0].metrics["durability.workflow_steps_per_turn"].reason,
    "missing-step-payload",
    "a purged payload is unknown, not zero bytes",
  );

  writeFileSync(
    join(leg, "world", `${runId}.json`),
    JSON.stringify({ runId, world: "local", events: [] }),
  );
  assert.equal(
    build(legsDir)[0].metrics["durability.workflow_steps_per_turn"].reason,
    "empty-world-run",
    "a run with turns but no workflow steps is an incomplete export, not zero work",
  );
});

test("turns build, start, and dev-startup probes into framework records", (t) => {
  const legsDir = legsDirectory(t);
  const leg = join(legsDir, "benchmark-leg-mock__agent-tools__mock__postgres__1");
  mkdirSync(join(leg, "probes"), { recursive: true });
  writeFileSync(
    join(leg, "meta.json"),
    JSON.stringify({
      leg_id: "mock__agent-tools__mock__postgres__1",
      sha: SHA,
      runner_os: "Linux",
    }),
  );
  const profile = (durationMs) => ({
    kind: "eve-build-profile",
    schemaVersion: 1,
    target: "local",
    durationMs,
    phases: [
      { name: "compile", durationMs: durationMs / 2 },
      { name: "sandbox.prewarm", durationMs: durationMs / 4 },
    ],
  });
  writeFileSync(join(leg, "probes", "build-profile.json"), JSON.stringify(profile(4000)));
  const devStartupDir = mkdtempSync(join(tmpdir(), "eve-dev-startup-"));
  t.after(() => rmSync(devStartupDir, { recursive: true, force: true }));
  writeFileSync(join(devStartupDir, "meta.json"), JSON.stringify({ sha: SHA, runner_os: "Linux" }));
  writeFileSync(
    join(devStartupDir, "minimal.jsonl"),
    [
      { root: "/tmp/x", toolCount: 0 },
      { run: 1, mode: "dev", wallMs: 900, sessionAcceptedMs: 950, firstTurnMs: 1100 },
      { run: 1, mode: "build", wallMs: 3000, profile: profile(2800) },
      {
        run: 1,
        mode: "start",
        wallMs: 600,
        probes: { attempts: 20, timedOut: 0, refused: 19 },
      },
      { mode: "dev", medianMs: 900 },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );

  const records = buildFrameworkRecords({
    plan,
    legs: readLegs(plan, legsDir),
    devStartupDir,
    githubRunId: "123",
    runAttempt: 1,
  });
  const summary = records.map((r) => [r.probe, r.subject, r.world, r.attempt, r.cold, r.missing]);
  // Every mock-leg probe and each agent's first run start from an empty project.
  assert.deepEqual(summary, [
    ["build", "agent-tools", "postgres", 1, true, null],
    ["start", "agent-tools", "postgres", 1, true, "probe-missing"],
    ["dev-startup", "minimal", "local", 1, true, null],
    ["build", "minimal", "local", 1, true, null],
    ["start", "minimal", "local", 1, true, null],
    ["dev-startup", "minimal", "local", 2, false, "run-missing"],
    ["build", "minimal", "local", 2, false, "run-missing"],
    ["start", "minimal", "local", 2, false, "run-missing"],
  ]);
  assert.deepEqual(
    [records[0].subject_digest, records[2].subject_digest],
    ["f".repeat(64), "b".repeat(40)],
  );
  assert.deepEqual(records[4].metrics, { "start.ready_ms": { status: "measured", value: 600 } });
  assert.deepEqual(records[0].metrics, {
    "build.total_ms": { status: "measured", value: 4000 },
    "build.without_sandbox_prewarm_ms": { status: "measured", value: 3000 },
    "build.phase_ms.compile": { status: "measured", value: 2000 },
    "build.phase_ms.sandbox.prewarm": { status: "measured", value: 1000 },
  });
  assert.equal(records[0].artifact_path, "raw/agent-tools/mock/postgres/1");
  assert.deepEqual(records[2].metrics, {
    "dev_startup.ready_ms": { status: "measured", value: 900 },
    "dev_startup.session_accepted_ms": { status: "measured", value: 950 },
    "dev_startup.first_turn_ms": { status: "measured", value: 1100 },
  });
  assert.equal(
    buildFrameworkRecords({
      plan,
      legs: readLegs(plan, legsDir),
      devStartupDir: undefined,
      githubRunId: "123",
      runAttempt: 1,
    })[2].missing,
    "job-missing",
  );
});

test("excludes live-leg evals whose model steps all ran on another model", (t) => {
  const legsDir = legsDirectory(t);
  const leg = join(legsDir, "benchmark-leg-live__agent-tools__alpha__local__1");
  // Some fixtures script delegation evals with eve's mock models even on live legs.
  writeEval(leg, "static-tools/no-reply", "eve-mock/notebook-parent");
  const { records, excluded } = buildWithExclusions(legsDir);
  assert.deepEqual(excluded, [
    { leg_id: "live__agent-tools__alpha__local__1", eval_id: "static-tools/no-reply" },
  ]);
  const live = records.filter((r) => r.model_id === "acme/alpha");
  assert.deepEqual(
    live.map((r) => r.eval_id),
    ["static-tools/ends-turn-function"],
    "an excluded eval is neither a result nor missing",
  );
});

test("rejects artifacts that were not planned or ran at another commit", (t) => {
  assert.throws(
    () => readLegs(plan, legsDirectory(t, { sha: "b".repeat(40) })),
    /ran at b+, but the plan is for a+/,
  );
  const unplanned = { ...plan, legs: plan.legs.slice(1) };
  assert.throws(() => readLegs(unplanned, legsDirectory(t)), /was not planned/);
});

function memoryStore() {
  const objects = new Map();
  const writes = [];
  return {
    objects,
    writes,
    async put(pathname, body) {
      if (objects.has(pathname))
        throw new Error(`Vercel Blob: This blob already exists (${pathname}).`);
      objects.set(pathname, Buffer.from(body));
      writes.push(pathname);
    },
    async read(pathname) {
      return objects.get(pathname) ?? null;
    },
  };
}

test("publishes raw trees and records before the manifest, idempotently and immutably", async (t) => {
  const legsDir = legsDirectory(t);
  const legs = readLegs(plan, legsDir);
  const recordsJsonl = build(legsDir)
    .map((record) => `${JSON.stringify(record)}\n`)
    .join("");
  const store = memoryStore();
  const input = {
    plan,
    legs,
    recordsJsonl,
    frameworkRecordsJsonl: "",
    githubRunId: "123",
    runAttempt: 1,
    eveVersion: "0.71.2",
    store,
  };

  const result = await publishRun(input);
  assert.equal(result.prefix, "runs/123/1");
  assert.equal(store.writes.at(-1), "runs/123/1/manifest.json");
  assert(
    store.objects.has(
      "runs/123/1/raw/agent-tools/alpha/local/1/run/evals/static-tools/ends-turn-function.json",
    ),
  );
  assert(store.objects.has("runs/123/1/raw/agent-tools/alpha/local/1/meta.json"));
  assert(store.objects.has("runs/123/1/framework-records.jsonl"));
  const manifest = JSON.parse(store.objects.get("runs/123/1/manifest.json"));
  assert.equal(manifest.record_count, 6);
  assert.equal(manifest.files.records.count, 6);
  assert.equal(manifest.files.framework_records.path, "framework-records.jsonl");
  // Ingest reads every metric's scope from the run, not from a hard-coded list.
  assert.deepEqual(
    manifest.metrics.records["attribution.framework_ms"],
    STANDARD_METRICS["attribution.framework_ms"],
  );
  assert.equal(manifest.metrics.records["cost.total_usd"].scope, "model");
  assert.equal(manifest.metrics.framework_records["start.ready_ms"].scope, "framework");
  assert.deepEqual(
    manifest.legs.map((leg) => leg.uploaded),
    [true, false, false],
  );

  const writes = store.writes.length;
  await publishRun(input);
  assert.equal(store.writes.length, writes, "identical re-run is a no-op");

  await assert.rejects(
    publishRun({ ...input, recordsJsonl: recordsJsonl.split("\n").slice(1).join("\n") }),
    /records.jsonl was already published with different content/,
  );
});
