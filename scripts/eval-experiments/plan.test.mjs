import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlan, validateDefinition, mergeSettings } from "./plan.mjs";

function configurationExperiment() {
  return {
    evals: [{ fixture: "fixture", include: ["case"] }],
    matrix: { configuration: { baseline: {}, candidate: {} } },
    measurements: {
      timing: {
        version: 1,
        metrics: { elapsed: { unit: "ms", direction: "lower" } },
      },
    },
    sampling: { repetitions: 2, seed: 42 },
    execution: { maxConcurrency: 1 },
    analysis: {
      compare: { axis: "configuration", baseline: "baseline" },
      primaryMetric: "timing.elapsed",
      eligibility: "paired-correct",
    },
  };
}

test("accepts omitted sources but rejects empty or malformed explicit source maps", () => {
  const definition = configurationExperiment();
  assert.doesNotThrow(() => validateDefinition(definition));
  for (const source of [{}, null, [], "HEAD"]) {
    assert.throws(
      () => validateDefinition({ ...definition, matrix: { ...definition.matrix, source } }),
      /matrix.source must be omitted or a non-empty named map/,
    );
  }
});

test("pins omitted sources to HEAD and preserves explicit source semantics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eve-experiment-plan-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    git("config", "user.name", "Experiment Test");
    git("config", "user.email", "experiment@example.test");
    await mkdir(join(root, "experiments"));
    await mkdir(join(root, "e2e/fixtures/fixture/evals"), { recursive: true });
    await writeFile(join(root, "e2e/fixtures/fixture/package.json"), '{"name":"fixture"}');
    await writeFile(join(root, "e2e/fixtures/fixture/evals/case.eval.ts"), "");
    git("add", ".");
    git(
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-s",
      "-m",
      "Fixture",
    );
    const earlierRevision = git("rev-parse", "HEAD");
    const omitted = configurationExperiment();
    const explicit = {
      ...omitted,
      matrix: { ...omitted.matrix, source: { pinned: { revision: earlierRevision } } },
    };
    const sourceComparison = {
      ...omitted,
      analysis: { ...omitted.analysis, compare: { axis: "source", baseline: "head" } },
    };
    const symbolic = {
      ...omitted,
      matrix: { ...omitted.matrix, source: { pinned: { revision: "HEAD" } } },
    };
    for (const [name, definition] of Object.entries({
      omitted,
      explicit,
      sourceComparison,
      symbolic,
    })) {
      await writeFile(
        join(root, `experiments/${name}.mjs`),
        `const definition = ${JSON.stringify(definition)};\ndefinition.measurements.timing.derive = () => ({});\nexport default definition;\n`,
      );
    }
    await writeFile(
      join(root, "experiments/helper.mjs"),
      'import "./nested.mjs";\nexport const derive = () => ({});\n',
    );
    await writeFile(join(root, "experiments/nested.mjs"), "export {};\n");
    await writeFile(
      join(root, "experiments/recursiveImport.mjs"),
      `import { derive } from "./helper.mjs";\nexport default { ...${JSON.stringify(omitted)}, measurements: { timing: { version: 1, metrics: { elapsed: { unit: "ms", direction: "lower" } }, derive } } };\n`,
    );
    git("add", ".");
    git(
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-s",
      "-m",
      "Definitions",
    );
    const revision = git("rev-parse", "HEAD");
    const planFor = (name) => createPlan(join(root, `experiments/${name}.mjs`), { root });

    await t.test("omitted source is pinned in provenance and every scheduled cell", async () => {
      const plan = await planFor("omitted");
      assert.deepEqual(plan.sources, [{ label: "head", sha: revision }]);
      assert.equal(plan.experimentRevision, revision);
      assert.equal(plan.executions, 4);
      assert.ok(plan.schedule.every((cell) => cell.source === "head"));
      assert.deepEqual(plan.diffs, []);
      assert.equal((await planFor("omitted")).planHash, plan.planHash);
    });
    await t.test("explicit source stays pinned independently of HEAD", async () => {
      const plan = await planFor("explicit");
      assert.deepEqual(plan.sources, [{ label: "pinned", sha: earlierRevision }]);
      assert.ok(plan.schedule.every((cell) => cell.source === "pinned"));
    });
    await t.test("source comparisons still require multiple entries", async () => {
      await assert.rejects(planFor("sourceComparison"), /baseline and at least one other entry/);
    });
    await t.test("explicit symbolic revisions remain invalid", async () => {
      await assert.rejects(planFor("symbolic"), /Invalid source entry/);
    });
    await t.test("includes transitive measurement imports in provenance", async () => {
      const plan = await planFor("recursiveImport");
      assert.deepEqual(plan.measurementImplementation.map((module) => module.path).sort(), [
        "experiments/helper.mjs",
        "experiments/nested.mjs",
      ]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid repetition budgets before repository access", () => {
  assert.throws(
    () =>
      validateDefinition({
        evals: [{ fixture: "fixture", include: ["case"] }],
        matrix: {
          source: { baseline: { revision: "a" }, candidate: { revision: "b" } },
          configuration: { default: {} },
        },
        measurements: {},
        sampling: { repetitions: 31, seed: 42 },
        execution: { maxConcurrency: 1 },
        analysis: {
          compare: { axis: "source", baseline: "baseline" },
          primaryMetric: "metric",
          eligibility: "paired-correct",
        },
      }),
    /repetitions must be an integer from 1 to 30/,
  );
});

test("rejects unknown settings scopes and reasoning values", () => {
  const base = {
    evals: [{ fixture: "fixture", include: ["case"] }],
    matrix: {
      source: { baseline: { revision: "a" }, candidate: { revision: "b" } },
      configuration: { default: {} },
    },
    measurements: {},
    sampling: { repetitions: 1, seed: 1 },
    execution: { maxConcurrency: 1 },
    analysis: {
      compare: { axis: "source", baseline: "baseline" },
      primaryMetric: "metric",
      eligibility: "paired-correct",
    },
  };
  assert.throws(() => mergeSettings({ child: {} }, {}), /Unsupported settings scope/);
  assert.throws(
    () => validateDefinition({ ...base, settings: { parent: { reasoning: "maximum" } } }),
    /Invalid eve reasoning/,
  );
  assert.deepEqual(
    mergeSettings(
      { parent: { model: "parent/a", reasoning: "high" } },
      { parent: { reasoning: "medium" }, selfModification: { model: "child/b" } },
    ),
    {
      parent: { model: "parent/a", reasoning: "medium" },
      selfModification: { model: "child/b" },
    },
  );
});
