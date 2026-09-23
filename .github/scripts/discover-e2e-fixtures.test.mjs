import assert from "node:assert/strict";
import test from "node:test";

import { discoverE2eFixtures } from "./discover-e2e-fixtures.mjs";

const registry = {
  models: [{ name: "model-a", id: "provider/model-a" }],
  worlds: [{ name: "vercel" }, { name: "postgres", package: "world-postgres" }],
};

function discover(packageJson, additionalFixtures = [], evals = [], selectedRegistry = registry) {
  return discoverE2eFixtures({
    registry: selectedRegistry,
    fixtures: [
      { name: "fixture", dir: "fixtures/fixture", packageJson, evals },
      ...additionalFixtures,
    ],
  });
}

function worldMatrix(result, world) {
  return JSON.parse(result.lines.match(new RegExp(`world_matrix_${world}=(.*)`))[1]);
}

test("omitted e2e.worlds selects every registered world", () => {
  const result = discover({});

  assert.deepEqual(worldMatrix(result, "vercel"), [{ name: "fixture", dir: "fixtures/fixture" }]);
  assert.deepEqual(worldMatrix(result, "postgres"), [
    { name: "fixture", dir: "fixtures/fixture", world_package: "world-postgres" },
  ]);
});

test("a registered world must retain at least one fixture", () => {
  assert.throws(
    () => discover({ e2e: { worlds: [] } }),
    /No e2e fixtures select the registered world "vercel"/u,
  );
});

test("a valid e2e.worlds subset selects only that world", () => {
  const result = discover({ e2e: { worlds: ["postgres"] } }, [
    {
      name: "vercel-fixture",
      dir: "fixtures/vercel-fixture",
      packageJson: { e2e: { worlds: ["vercel"] } },
    },
  ]);

  assert.deepEqual(worldMatrix(result, "vercel"), [
    { name: "vercel-fixture", dir: "fixtures/vercel-fixture" },
  ]);
  assert.deepEqual(worldMatrix(result, "postgres"), [
    { name: "fixture", dir: "fixtures/fixture", world_package: "world-postgres" },
  ]);
});

test("an unknown e2e.worlds entry is rejected", () => {
  assert.throws(() => discover({ e2e: { worlds: ["missing"] } }), /unknown e2e world "missing"/u);
});

test("model shards expand across selected models without multiplying world legs", () => {
  const evals = ["nested/one", "nested/two", "three"];
  const result = discover(
    {
      e2e: {
        worlds: ["postgres"],
        modelMatrix: "full",
        modelShards: [
          { name: "shard-1", evals: ["nested/one", "nested/two"] },
          { name: "shard-2", evals: ["three"] },
        ],
      },
    },
    [
      {
        name: "vercel-fixture",
        dir: "fixtures/vercel-fixture",
        packageJson: { e2e: { worlds: ["vercel"] } },
        evals: [],
      },
    ],
    evals,
    {
      ...registry,
      models: [...registry.models, { name: "model-b", id: "provider/model-b" }],
    },
  );

  assert.deepEqual(
    result.modelMatrix
      .filter(({ name }) => name === "fixture")
      .map(({ model_name, shard, eval_ids }) => ({ model_name, shard, eval_ids })),
    [
      { model_name: "model-a", shard: "shard-1", eval_ids: ["nested/one", "nested/two"] },
      { model_name: "model-a", shard: "shard-2", eval_ids: ["three"] },
      { model_name: "model-b", shard: "shard-1", eval_ids: ["nested/one", "nested/two"] },
      { model_name: "model-b", shard: "shard-2", eval_ids: ["three"] },
    ],
  );
  assert.deepEqual(worldMatrix(result, "vercel"), [
    { name: "vercel-fixture", dir: "fixtures/vercel-fixture" },
  ]);
  assert.deepEqual(worldMatrix(result, "postgres"), [
    { name: "fixture", dir: "fixtures/fixture", world_package: "world-postgres" },
  ]);
});

test("unsharded fixtures keep one model entry with all evals implicit", () => {
  const result = discover({}, [], ["nested/one", "two"]);
  assert.deepEqual(result.modelMatrix, [
    {
      name: "fixture",
      dir: "fixtures/fixture",
      model_name: "model-a",
      model_id: "provider/model-a",
      optional: false,
    },
  ]);
});

test("model shards reject empty shard lists, names, and eval lists", () => {
  for (const modelShards of [
    [],
    [{ name: "", evals: ["one"] }],
    [{ name: "shard-1", evals: [] }],
  ]) {
    assert.throws(() => discover({ e2e: { modelShards } }, [], ["one"]), /e2e.modelShards/u);
  }
});

test("model shards reject duplicate shard names", () => {
  assert.throws(
    () =>
      discover(
        {
          e2e: {
            modelShards: [
              { name: "same", evals: ["one"] },
              { name: "same", evals: ["two"] },
            ],
          },
        },
        [],
        ["one", "two"],
      ),
    /duplicate shard name "same"/u,
  );
});

test("model shards reject duplicate and unknown eval assignments", () => {
  assert.throws(
    () =>
      discover({ e2e: { modelShards: [{ name: "shard-1", evals: ["one", "one"] }] } }, [], ["one"]),
    /assigns eval "one" more than once/u,
  );
  assert.throws(
    () =>
      discover({ e2e: { modelShards: [{ name: "shard-1", evals: ["missing"] }] } }, [], ["one"]),
    /references unknown eval "missing"/u,
  );
});

test("model shards reject discovered evals that are unassigned", () => {
  assert.throws(
    () =>
      discover({ e2e: { modelShards: [{ name: "shard-1", evals: ["one"] }] } }, [], ["one", "two"]),
    /does not assign discovered eval: two/u,
  );
});
