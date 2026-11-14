import assert from "node:assert/strict";
import test from "node:test";

import { discoverE2eFixtures, isRealModelEval } from "./discover-e2e-fixtures.mjs";

const registry = {
  models: [{ name: "model-a", id: "provider/model-a" }],
  worlds: [{ name: "vercel" }, { name: "postgres", package: "world-postgres" }],
};

// A fixture without explicit evals gets one untagged eval, so the world suites run it.
// Explicit evals are tagged `real-model` unless the fixture says otherwise.
function withEvals(fixture) {
  const evals = fixture.evals ?? ["world"];
  return { ...fixture, evals, realModelEvals: fixture.realModelEvals ?? fixture.evals ?? [] };
}

function discover(
  packageJson,
  additionalFixtures = [],
  evals,
  selectedRegistry = registry,
  realModelEvals,
) {
  return discoverE2eFixtures({
    registry: selectedRegistry,
    fixtures: [
      withEvals({
        name: "fixture",
        dir: "fixtures/fixture",
        packageJson: { name: "fixture-package", ...packageJson },
        evals,
        realModelEvals,
      }),
      ...additionalFixtures.map((fixture) =>
        withEvals({
          ...fixture,
          packageJson: { name: `${fixture.name}-package`, ...fixture.packageJson },
        }),
      ),
    ],
  });
}

function worldMatrix(result, world) {
  return JSON.parse(result.lines.match(new RegExp(`world_matrix_${world}=(.*)`))[1]);
}

test("omitted e2e.worlds selects every registered world", () => {
  const result = discover({});

  assert.deepEqual(worldMatrix(result, "vercel"), [
    { name: "fixture", package: "fixture-package", dir: "fixtures/fixture" },
  ]);
  assert.deepEqual(worldMatrix(result, "postgres"), [
    {
      name: "fixture",
      package: "fixture-package",
      dir: "fixtures/fixture",
      world_package: "world-postgres",
    },
  ]);
});

test("a registered world must retain at least one fixture", () => {
  assert.throws(
    () => discover({ e2e: { worlds: [] } }),
    /No e2e fixtures select the registered world "vercel"/u,
  );
});

test("fixtures need a valid package name for Turbo filtering", () => {
  for (const packageJson of [{}, { name: "fixture$(invalid)" }, { name: "fixture...deps" }]) {
    assert.throws(
      () =>
        discoverE2eFixtures({
          registry,
          fixtures: [{ name: "fixture", dir: "fixtures/fixture", packageJson }],
        }),
      /every e2e fixture needs a valid package name/u,
    );
  }
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
    {
      name: "vercel-fixture",
      package: "vercel-fixture-package",
      dir: "fixtures/vercel-fixture",
    },
  ]);
  assert.deepEqual(worldMatrix(result, "postgres"), [
    {
      name: "fixture",
      package: "fixture-package",
      dir: "fixtures/fixture",
      world_package: "world-postgres",
    },
  ]);
});

test("an unknown e2e.worlds entry is rejected", () => {
  assert.throws(() => discover({ e2e: { worlds: ["missing"] } }), /unknown e2e world "missing"/u);
});

test("model shards expand across selected models without multiplying world legs", () => {
  // "world" is untagged, so the fixture also runs in its world suite.
  const evals = ["nested/one", "nested/two", "three", "world"];
  const result = discover(
    {
      e2e: {
        worlds: ["postgres"],
        modelMatrix: "full",
        modelShards: [
          { name: "shard-1", evals: ["nested/one", "nested/two"] },
          { name: "shard-2", evals: ["three", "world"] },
        ],
      },
    },
    [
      {
        name: "vercel-fixture",
        dir: "fixtures/vercel-fixture",
        packageJson: { e2e: { worlds: ["vercel"] } },
      },
    ],
    evals,
    {
      ...registry,
      models: [...registry.models, { name: "model-b", id: "provider/model-b" }],
    },
    ["nested/one", "nested/two", "three"],
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
    {
      name: "vercel-fixture",
      package: "vercel-fixture-package",
      dir: "fixtures/vercel-fixture",
    },
  ]);
  assert.deepEqual(worldMatrix(result, "postgres"), [
    {
      name: "fixture",
      package: "fixture-package",
      dir: "fixtures/fixture",
      world_package: "world-postgres",
    },
  ]);
});

test("unsharded fixtures keep one model entry with all evals implicit", () => {
  const worlds = { name: "world-fixture", dir: "fixtures/world-fixture" };
  const result = discover({}, [worlds], ["nested/one", "two"]);
  assert.deepEqual(
    result.modelMatrix.filter(({ name }) => name === "fixture"),
    [
      {
        name: "fixture",
        package: "fixture-package",
        dir: "fixtures/fixture",
        model_name: "model-a",
        model_id: "provider/model-a",
        optional: false,
        model_evals: "real-model",
        mock_evals: false,
      },
    ],
  );
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

function discoverTagged(packageJson, evals, realModelEvals) {
  return discoverE2eFixtures({
    registry,
    fixtures: [
      {
        name: "fixture",
        dir: "fixtures/fixture",
        packageJson: { name: "fixture-package", ...packageJson },
        evals,
        realModelEvals,
      },
    ],
  });
}

test("a fixture without real-model evals gets one mock-only leg and keeps its world legs", () => {
  const result = discoverTagged({}, ["one", "two"], []);
  assert.deepEqual(
    result.modelMatrix.map(({ model_name, model_id, model_evals, mock_evals }) => ({
      model_name,
      model_id,
      model_evals,
      mock_evals,
    })),
    [{ model_name: "mock", model_id: "mock", model_evals: "none", mock_evals: true }],
  );
  assert.equal(worldMatrix(result, "vercel").length, 1);
  assert.equal(worldMatrix(result, "postgres").length, 1);
});

test("only the default model's leg runs a mixed fixture's other evals with the mock", () => {
  const result = discoverE2eFixtures({
    registry: { ...registry, models: [...registry.models, { name: "model-b", id: "provider/b" }] },
    fixtures: [
      {
        name: "fixture",
        dir: "fixtures/fixture",
        packageJson: { name: "fixture-package", e2e: { modelMatrix: "full" } },
        evals: ["one", "two"],
        realModelEvals: ["one"],
      },
    ],
  });
  assert.deepEqual(
    result.modelMatrix.map(({ model_name, model_evals, mock_evals }) => ({
      model_name,
      model_evals,
      mock_evals,
    })),
    [
      { model_name: "model-a", model_evals: "real-model", mock_evals: true },
      { model_name: "model-b", model_evals: "real-model", mock_evals: false },
    ],
  );
});

test("model shards split their evals between the real-model and mock passes", () => {
  const result = discoverTagged(
    {
      e2e: {
        modelShards: [
          { name: "mixed", evals: ["one", "two"] },
          { name: "untagged", evals: ["three"] },
        ],
      },
    },
    ["one", "two", "three"],
    ["two"],
  );
  assert.deepEqual(
    result.modelMatrix.map(({ shard, model_name, eval_ids, mock_eval_ids }) => ({
      shard,
      model_name,
      eval_ids,
      mock_eval_ids,
    })),
    [
      { shard: "untagged", model_name: "mock", eval_ids: undefined, mock_eval_ids: ["three"] },
      { shard: "mixed", model_name: "model-a", eval_ids: ["two"], mock_eval_ids: ["one"] },
    ],
  );
});

test('e2e.modelSuiteEvals "all" runs every eval on the real model and none with the mock', () => {
  const result = discoverTagged({ e2e: { modelSuiteEvals: "all" } }, ["one"], []);
  assert.deepEqual(
    result.modelMatrix.map(({ model_name, model_evals, mock_evals }) => ({
      model_name,
      model_evals,
      mock_evals,
    })),
    [{ model_name: "model-a", model_evals: "all", mock_evals: false }],
  );
});

test("e2e.modelSuiteEvals rejects unknown values", () => {
  assert.throws(
    () => discoverTagged({ e2e: { modelSuiteEvals: "some" } }, ["one"], ["one"]),
    /e2e.modelSuiteEvals must be "real-model" or "all"/u,
  );
});

test("isRealModelEval finds the literal tag among others", () => {
  assert.equal(isRealModelEval('defineEval({ tags: ["real-model"], test() {} })'), true);
  assert.equal(isRealModelEval("defineEval({ tags: ['hitl', 'real-model'] })"), true);
  assert.equal(isRealModelEval('defineEval({ tags: ["hitl"] }) // real-model'), false);
  assert.equal(isRealModelEval("defineEval({ description: 'no tags' })"), false);
});

test("a fixture whose evals are all real-model gets no world legs", () => {
  const result = discover({}, [{ name: "world-fixture", dir: "fixtures/world-fixture" }], ["one"]);
  for (const world of ["vercel", "postgres"]) {
    assert.deepEqual(
      worldMatrix(result, world).map(({ name }) => name),
      ["world-fixture"],
    );
  }
  assert.deepEqual(
    result.modelMatrix
      .filter(({ name }) => name === "fixture")
      .map(({ model_evals }) => model_evals),
    ["real-model"],
  );
});

test("a world with a fixtures list runs only those fixtures", () => {
  const listed = {
    ...registry,
    worlds: [{ name: "vercel", fixtures: ["listed"] }, { name: "postgres" }],
  };
  const result = discover({}, [{ name: "listed", dir: "fixtures/listed" }], undefined, listed);
  assert.deepEqual(
    worldMatrix(result, "vercel").map(({ name }) => name),
    ["listed"],
  );
  assert.deepEqual(
    worldMatrix(result, "postgres").map(({ name }) => name),
    ["fixture", "listed"],
  );
});

test("a world's fixtures list rejects unknown fixtures", () => {
  const listed = { ...registry, worlds: [{ name: "vercel", fixtures: ["missing"] }] };
  assert.throws(
    () => discover({}, [], undefined, listed),
    /world "vercel" lists unknown fixture "missing"/u,
  );
});
