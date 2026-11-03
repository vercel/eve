import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { publishedBenchmarkModels } from "../lib/benchmark-config.ts";
import { stageSiteResults } from "./stage-site-results.mjs";

const plan = { sha: "a".repeat(40), eve_revision: "b".repeat(40) };
const summary = "current/2026-10-26T00-00-00.000Z/author-001-weather-tool/summary.json";

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "eve-authoring-site-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { artifactsDir: join(root, "artifacts"), resultsRoot: join(root, "results") };
}

function artifact(artifactsDir, name, meta) {
  const dir = join(artifactsDir, name);
  mkdirSync(join(dir, summary, ".."), { recursive: true });
  writeFileSync(join(dir, summary), "{}");
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ sha: plan.sha, eve_revision: plan.eve_revision, runner_os: "Linux", ...meta }),
  );
}

test("stages each model and treatment under its published experiment id", (t) => {
  const { artifactsDir, resultsRoot } = workspace(t);
  artifact(artifactsDir, "authoring-benchmark-kimi-k3-x", {
    model_id: "kimi-k3",
    treatment: "guided",
  });
  artifact(artifactsDir, "authoring-baseline-kimi-k3-x", {
    model_id: "kimi-k3",
    treatment: "baseline",
  });

  const { staged, missing } = stageSiteResults({ plan, artifactsDir, resultsRoot });

  assert.deepEqual(staged.sort(), ["kimi-k3-opencode--baseline", "kimi-k3-opencode--guided"]);
  assert.equal(missing.length, publishedBenchmarkModels.length * 2 - 2);
  assert.ok(!missing.includes("kimi-k3-opencode--guided"));
  for (const experimentId of staged) {
    assert.ok(existsSync(join(resultsRoot, experimentId, summary.slice("current/".length))));
  }
});

test("rejects artifacts from another run, unpublished models, and duplicates", (t) => {
  for (const [meta, error] of [
    [{ model_id: "kimi-k3", treatment: "guided", sha: "c".repeat(40) }, /sha/u],
    [{ model_id: "kimi-k3", treatment: "guided", eve_revision: "c".repeat(40) }, /eve_revision/u],
    [{ model_id: "claude-haiku-5-5", treatment: "guided" }, /supported publication set/u],
    [{ model_id: "kimi-k3", treatment: "other" }, /Unknown treatment/u],
  ]) {
    const { artifactsDir, resultsRoot } = workspace(t);
    artifact(artifactsDir, "authoring-benchmark-x", meta);
    assert.throws(() => stageSiteResults({ plan, artifactsDir, resultsRoot }), error);
  }

  const { artifactsDir, resultsRoot } = workspace(t);
  artifact(artifactsDir, "a", { model_id: "kimi-k3", treatment: "guided" });
  artifact(artifactsDir, "b", { model_id: "moonshotai/kimi-k3", treatment: "guided" });
  assert.throws(() => stageSiteResults({ plan, artifactsDir, resultsRoot }), /more than one/u);
});
