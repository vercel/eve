import assert from "node:assert/strict";
import test from "node:test";

import { discoverE2eFixtures } from "./discover-e2e-fixtures.mjs";

const registry = {
  models: [{ name: "model-a", id: "provider/model-a" }],
  worlds: [{ name: "vercel" }, { name: "postgres", package: "world-postgres" }],
};

function discover(packageJson, additionalFixtures = []) {
  return discoverE2eFixtures({
    registry,
    fixtures: [{ name: "fixture", dir: "fixtures/fixture", packageJson }, ...additionalFixtures],
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
