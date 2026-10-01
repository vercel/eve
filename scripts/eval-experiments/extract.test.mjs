import test from "node:test";
import assert from "node:assert/strict";
import { validateCapturedArtifact, validateMeasurements, extractDirectory } from "./extract.mjs";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bundle = {
  version: 1,
  metrics: { count: { unit: "count", direction: "neutral" } },
  derive: () => ({ count: { status: "measured", value: 0 } }),
};
const artifact = { id: "case", verdict: "passed", result: { status: "completed", sessions: [] } };

test("validates the consumed eval artifact projection", () => {
  assert.equal(validateCapturedArtifact(artifact, "case").result.sessions.length, 0);
  assert.throws(
    () => validateCapturedArtifact({ ...artifact, id: "other" }, "case"),
    /artifact identity/,
  );
  assert.throws(
    () => validateCapturedArtifact({ ...artifact, result: {} }, "case"),
    /task result shape/,
  );
});

test("keeps artifacts with unavailable session captures analyzable", () => {
  const captured = validateCapturedArtifact(
    { ...artifact, result: { status: "completed" } },
    "case",
  );
  assert.equal(captured.result.sessions, undefined);
  assert.equal(
    validateMeasurements(
      { ...bundle, derive: () => ({ count: { status: "unavailable", reason: "no-capture" } }) },
      captured,
    ).count.status,
    "unavailable",
  );
});

test("extraction uses the recorded artifact and rejects duplicate evidence or changed definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-experiment-extract-"));
  try {
    const definition =
      'import { derive } from "./metric.mjs"; export default { measurements: { timing: { version: 1, metrics: { count: { unit: "count", direction: "neutral" } }, derive } } };\n';
    const metric = 'export const derive = () => ({ count: { status: "measured", value: 0 } });\n';
    await mkdir(join(root, "experiments"));
    await writeFile(join(root, "experiments/metric.mjs"), metric);
    const definitionPath = join(root, "experiments/test.mjs");
    await writeFile(definitionPath, definition);
    const plan = {
      definitionPath: "experiments/test.mjs",
      definitionSha256: createHash("sha256").update(definition).digest("hex"),
      measurementImplementation: [
        {
          path: "experiments/metric.mjs",
          sha256: createHash("sha256").update(metric).digest("hex"),
        },
      ],
      implementationRevision: "original",
      planHash: "hash",
      experimentRevision: "original",
      sources: [{ label: "base", sha: "abc" }],
      configurations: [{ label: "default", settings: {} }],
      schedule: [
        {
          source: "base",
          configuration: "default",
          fixture: "fixture",
          eval: "case",
          repetition: 0,
          executionOrder: 0,
        },
      ],
    };
    const attempt = join(root, "execution/raw/fixture/default/r0/base/case");
    await mkdir(join(attempt, "evals/stamp/evals"), { recursive: true });
    const invocation = {
      planHash: "hash",
      experimentRevision: "original",
      source: "base",
      sourceSha: "abc",
      configuration: "default",
      settings: {},
      fixture: "fixture",
      eval: "case",
      repetition: 0,
      executionOrder: 0,
      selectedEvals: ["case"],
      artifact: "raw/fixture/default/r0/base/case/evals/stamp",
      correctnessOutcome: "passed",
    };
    await writeFile(join(attempt, "invocation.json"), JSON.stringify(invocation));
    await writeFile(join(attempt, "evals/stamp/evals/case.json"), JSON.stringify(artifact));
    const execution = join(root, "execution");
    const result = await extractDirectory(execution, plan, { definitionPath });
    assert.equal(result.samples[0].measurements["timing.count"].value, 0);
    assert.deepEqual(result.analysisErrors, []);
    await writeFile(join(attempt, "evals/stamp/evals/duplicate.json"), JSON.stringify(artifact));
    const duplicated = await extractDirectory(execution, plan, { definitionPath });
    assert.deepEqual(
      duplicated.analysisErrors.map((entry) => entry.error),
      ["unexpected-or-duplicate-artifact"],
    );
    await writeFile(join(root, "experiments/metric.mjs"), metric.replace("value: 0", "value: 1"));
    await assert.rejects(
      extractDirectory(execution, plan, { definitionPath }),
      /supply a new analysis revision/,
    );
    const reanalysis = await extractDirectory(execution, plan, {
      definitionPath,
      analysisRevision: "new",
    });
    assert.equal(reanalysis.analysisRevision, "new");
    await writeFile(definitionPath, definition.replace("version: 1", "version: 2"));
    await assert.rejects(
      extractDirectory(execution, plan, { definitionPath }),
      /supply a new analysis revision/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects undeclared, invalid, and throwing measurement results", () => {
  const captured = validateCapturedArtifact(artifact, "case");
  assert.equal(validateMeasurements(bundle, captured).count.value, 0);
  assert.throws(
    () =>
      validateMeasurements(
        { ...bundle, derive: () => ({ other: { status: "measured", value: 1 } }) },
        captured,
      ),
    /keys do not match/,
  );
  assert.throws(
    () =>
      validateMeasurements(
        { ...bundle, derive: () => ({ count: { status: "measured", value: Infinity } }) },
        captured,
      ),
    /numeric measurement/,
  );
  assert.throws(
    () =>
      validateMeasurements(
        {
          ...bundle,
          derive: () => {
            throw new Error("broken");
          },
        },
        captured,
      ),
    /broken/,
  );
});
