import test from "node:test";
import assert from "node:assert/strict";
import { validateCapturedArtifact, validateMeasurements } from "./extract.mjs";

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
