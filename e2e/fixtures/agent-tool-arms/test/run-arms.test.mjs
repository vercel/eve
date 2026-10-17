import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { summarize } from "../scripts/summary.mjs";

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(fixture, "scripts/run-arms.mjs");

// A stand-in `pnpm` first on PATH, so run-arms.mjs takes its one real path
// (`pnpm exec eve eval ...`) and the stand-in appends rows as measure.ts would.
// It writes nothing when FAKE_EVAL_ROWS=0, like an eval process that died.
const bin = mkdtempSync(join(tmpdir(), "arms-bin-"));
writeFileSync(
  join(bin, "pnpm"),
  `#!${process.execPath}
const fs = require("node:fs");
const e = process.env;
const n = Number(e.FAKE_EVAL_ROWS ?? 10);
for (let i = 0; i < n; i++)
  fs.appendFileSync(e.EVE_ARMS_OUTPUT, JSON.stringify({
    id: "t" + i, model: e.EVE_E2E_MODEL, size: e.EVE_ARMS_SIZE, arm: e.EVE_ARMS_MODE,
    repetition: Number(e.EVE_ARMS_REPETITION), success: true, errorClass: null,
    inputTokens: 100, cacheReadTokens: 50, modelCalls: 2, actions: 1, programAttempts: 0,
    latencyMs: 1000, programErrorClasses: [] }) + "\\n");
console.log("Results: " + n + " passed (" + n + " total)");
`,
);
chmodSync(join(bin, "pnpm"), 0o755);
after(() => rmSync(bin, { recursive: true }));

const run = (env, args = []) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      EVE_ARMS_MODELS: "m/one",
      EVE_ARMS_SIZES: "moderate",
      EVE_ARMS_MODES: "direct",
      EVE_ARMS_REPETITIONS: "1",
      ...env,
    },
  });
const rows = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean);
const tempOutput = () => join(mkdtempSync(join(tmpdir(), "arms-")), "m.jsonl");

test("repeated executions each get their own dataset", () => {
  const before = new Set(safeList(join(fixture, "results/runs")));
  const first = run({ EVE_ARMS_OUTPUT: undefined });
  const second = run({ EVE_ARMS_OUTPUT: undefined });
  const created = safeList(join(fixture, "results/runs")).filter((d) => !before.has(d));
  try {
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(created.length, 2);
    for (const dir of created) {
      const path = join(fixture, "results/runs", dir);
      assert.equal(rows(join(path, "measurements.jsonl")).length, 10);
      assert.match(readFileSync(join(path, "summary.md"), "utf8"), /\| 10\/10 \| 10\/10 \|/);
    }
    assert.match(second.stdout, /\| 10\/10 \| 10\/10 \|/);
  } finally {
    for (const dir of created) rmSync(join(fixture, "results/runs", dir), { recursive: true });
  }
});

test("an output that already holds a dataset is refused and left as it was", () => {
  const output = tempOutput();
  assert.equal(run({ EVE_ARMS_OUTPUT: output }).status, 0);
  const second = run({ EVE_ARMS_OUTPUT: output });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already holds a dataset/);
  assert.equal(rows(output).length, 10);
  rmSync(dirname(output), { recursive: true });
});

test("--summary prints the table and writes nothing", () => {
  const output = tempOutput();
  run({ EVE_ARMS_OUTPUT: output });
  rmSync(join(dirname(output), "summary.md"));
  const files = readdirSync(dirname(output)).sort();
  const baseline = join(fixture, "results/baseline/measurements.jsonl");
  const baselineBefore = statSync(baseline).mtimeMs;
  const summary = run({}, ["--summary", output]);
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /\| m\/one \| moderate \| direct \| 10\/10 \| 10\/10 \|/);
  assert.deepEqual(readdirSync(dirname(output)).sort(), files);
  const fromBaseline = run({}, ["--summary"]);
  assert.match(fromBaseline.stdout, /\| 27\/30 \| 30\/30 \|/);
  assert.equal(fromBaseline.stdout.trim().split("\n").length, 14);
  assert.equal(statSync(baseline).mtimeMs, baselineBefore);
  rmSync(dirname(output), { recursive: true });
});

test("configurations that recorded no rows show as 0 runs, then and later", () => {
  const output = tempOutput();
  const execution = run({
    EVE_ARMS_OUTPUT: output,
    EVE_ARMS_MODES: "direct,deferred",
    EVE_ARMS_REPETITIONS: "3",
    FAKE_EVAL_ROWS: "0",
  });
  assert.equal(execution.status, 0, execution.stderr);
  for (const text of [execution.stdout, run({}, ["--summary", output]).stdout]) {
    assert.match(text, /\| m\/one \| moderate \| direct \| 0\/0 \| 0\/30 \|/);
    assert.match(text, /\| m\/one \| moderate \| deferred \| 0\/0 \| 0\/30 \|/);
  }
  rmSync(dirname(output), { recursive: true });
});

test("--summary of a dataset without a matrix fails and writes nothing", () => {
  const output = tempOutput();
  run({ EVE_ARMS_OUTPUT: output });
  rmSync(join(dirname(output), "matrix.json"));
  rmSync(join(dirname(output), "summary.md"));
  const files = readdirSync(dirname(output)).sort();
  const summary = run({}, ["--summary", output]);
  assert.notEqual(summary.status, 0);
  assert.match(summary.stderr, /matrix\.json/);
  assert.equal(summary.stdout, "");
  assert.deepEqual(readdirSync(dirname(output)).sort(), files);
  rmSync(dirname(output), { recursive: true });
});

test("summarize lists every requested configuration even with no rows", () => {
  const table = summarize([], { models: ["a"], sizes: ["s"], arms: ["x", "y"], repetitions: 3 });
  assert.match(table, /\| a \| s \| x \| 0\/0 \| 0\/30 \| - \|/);
  assert.match(table, /\| a \| s \| y \| 0\/0 \| 0\/30 \| - \|/);
});

function safeList(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
