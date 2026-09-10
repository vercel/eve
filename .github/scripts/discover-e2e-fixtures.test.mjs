import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(new URL("./discover-e2e-fixtures.mjs", import.meta.url));

function discover(overrides = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: "",
      EVE_E2E_FIXTURE: "",
      EVE_E2E_MODEL_NAME: "",
      EVE_E2E_REPETITIONS: "",
      EVE_E2E_SHARDS: "",
      ...overrides,
    },
  });
}

function matrices(overrides = {}) {
  const result = discover(overrides);
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), JSON.parse(line.slice(separator + 1))];
      }),
  );
}

const selection = {
  EVE_E2E_FIXTURE: "agent-compaction-regressions",
  EVE_E2E_MODEL_NAME: "anthropic-opus",
};

test("ordinary discovery does not alter job names or add repetition shards", () => {
  const { model_matrix: legs } = matrices();
  assert.ok(legs.length > 1);
  assert.ok(legs.some((leg) => leg.model_name === "anthropic-opus"));
  for (const leg of legs) {
    assert.equal(leg.job_suffix, undefined);
    assert.equal(leg.repetition_shard, undefined);
  }
});

test("manual selection narrows the model matrix without changing world matrices", () => {
  const { model_matrix: original, ...worlds } = matrices();
  const { model_matrix: selected, ...selectedWorlds } = matrices(selection);
  assert.deepEqual(
    selected,
    original.filter(
      (leg) =>
        leg.name === selection.EVE_E2E_FIXTURE && leg.model_name === selection.EVE_E2E_MODEL_NAME,
    ),
  );
  assert.equal(selected.length, 1);
  assert.deepEqual(selectedWorlds, worlds);
});

test("repeated validation gives every shard a distinct job identity", () => {
  const { model_matrix: legs } = matrices({
    ...selection,
    EVE_E2E_REPETITIONS: "20",
    EVE_E2E_SHARDS: "5",
  });
  assert.equal(legs.length, 5);
  assert.deepEqual(
    legs.map((leg) => leg.repetition_shard),
    [1, 2, 3, 4, 5],
  );
  assert.equal(new Set(legs.map((leg) => leg.job_suffix)).size, 5);
  assert.ok(legs.every((leg) => leg.name === "agent-compaction-regressions"));
});

test("invalid and unbounded repetition requests fail before allocating a matrix", () => {
  for (const overrides of [
    { EVE_E2E_REPETITIONS: "0" },
    { EVE_E2E_REPETITIONS: "501" },
    { EVE_E2E_REPETITIONS: "1.5" },
    { EVE_E2E_REPETITIONS: "20", EVE_E2E_SHARDS: "0" },
    { EVE_E2E_REPETITIONS: "20", EVE_E2E_SHARDS: "11" },
    { EVE_E2E_REPETITIONS: "100", EVE_E2E_SHARDS: "6" },
    { EVE_E2E_SHARDS: "5" },
    { EVE_E2E_REPETITIONS: "20", EVE_E2E_FIXTURE: "" },
    { EVE_E2E_REPETITIONS: "20", EVE_E2E_MODEL_NAME: "" },
    { EVE_E2E_FIXTURE: "missing-fixture" },
    { EVE_E2E_MODEL_NAME: "missing-model" },
  ]) {
    const result = discover({ ...selection, ...overrides });
    assert.notEqual(result.status, 0, JSON.stringify(overrides));
    assert.equal(result.stdout, "");
  }
});
