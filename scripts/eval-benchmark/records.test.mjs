import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishRun } from "./publish.mjs";
import { buildRecords, readLegs } from "./records.mjs";

const SHA = "a".repeat(40);
const plan = {
  schema_version: 1,
  sha: SHA,
  planned_at: "2026-01-01T00:00:00.000Z",
  registry: {
    attempts: 1,
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
    ],
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
  const manifest = JSON.parse(store.objects.get("runs/123/1/manifest.json"));
  assert.equal(manifest.record_count, 4);
  assert.deepEqual(
    manifest.legs.map((leg) => leg.uploaded),
    [true, false],
  );

  const writes = store.writes.length;
  await publishRun(input);
  assert.equal(store.writes.length, writes, "identical re-run is a no-op");

  await assert.rejects(
    publishRun({ ...input, recordsJsonl: recordsJsonl.split("\n").slice(1).join("\n") }),
    /records.jsonl was already published with different content/,
  );
});
