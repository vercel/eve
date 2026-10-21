import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveModelReleases } from "./catalog.mjs";
import { planLegs, selectBenchmark } from "./plan.mjs";

const registry = {
  models: [
    { name: "alpha", id: "acme/alpha" },
    { name: "beta", id: "acme/beta" },
  ],
  fixtures: ["agent-one", "agent-two"],
  mockWorlds: ["local", "postgres"],
  attempts: 2,
  concurrency: { legs: 3, evalsPerLeg: 1 },
};
const matrix = {
  worlds: [{ name: "vercel" }, { name: "postgres", package: "@workflow/world-postgres" }],
};
const fixtures = {
  "agent-one": { dir: "e2e/fixtures/agent-one", evalIds: ["a", "b"] },
  "agent-two": {
    dir: "e2e/fixtures/agent-two",
    evalIds: ["c"],
    packageJson: { e2e: { worlds: ["vercel"] } },
  },
};
const select = (overrides = {}, narrow = {}) =>
  selectBenchmark({
    registry: { ...registry, ...overrides },
    matrix,
    findFixture: (name) => fixtures[name],
    narrow,
  });

test("expands fixtures × models × attempts and mock worlds the fixture selects", () => {
  const selection = select();
  assert.deepEqual(selection.concurrency, { legs: 3, evalsPerLeg: 1 });
  const { live, mock } = planLegs(selection);
  assert.equal(live.length, 2 * 2 * 2);
  // Models vary fastest so legs started together spread across models, and
  // each eval's attempts are spread over the run.
  assert.deepEqual(
    live.slice(0, 5).map((leg) => leg.leg_id),
    [
      "live__agent-one__alpha__local__1",
      "live__agent-one__beta__local__1",
      "live__agent-two__alpha__local__1",
      "live__agent-two__beta__local__1",
      "live__agent-one__alpha__local__2",
    ],
  );
  assert.deepEqual(live[0], {
    leg_id: "live__agent-one__alpha__local__1",
    kind: "live",
    fixture: "agent-one",
    dir: "e2e/fixtures/agent-one",
    model_name: "alpha",
    model_id: "acme/alpha",
    world: "local",
    world_package: "",
    attempt: 1,
  });
  assert.equal(new Set(live.map((leg) => leg.leg_id)).size, live.length);
  assert.deepEqual(
    mock.map((leg) => [leg.leg_id, leg.world_package]),
    [
      ["mock__agent-one__mock__local__1", ""],
      ["mock__agent-one__mock__postgres__1", "@workflow/world-postgres"],
      ["mock__agent-two__mock__local__1", ""],
    ],
  );
});

test("dispatch inputs narrow every dimension and reject unknown names", () => {
  const selection = select({}, { models: "beta", fixtures: "agent-two", attempts: "1" });
  assert.deepEqual(
    planLegs(selection).live.map((leg) => leg.leg_id),
    ["live__agent-two__beta__local__1"],
  );
  assert.deepEqual(planLegs(select({}, { fixtures: "none" })), { live: [], mock: [] });
  assert.throws(
    () => select({}, { models: "gamma" }),
    /Unknown benchmark model gamma; choose from alpha, beta/,
  );
  assert.throws(
    () => select({}, { models: "beta,beta" }),
    /Benchmark model input "beta,beta" contains duplicates/,
  );
  assert.throws(
    () => select({}, { attempts: "0" }),
    /attempts input must be an integer from 1 to 10/,
  );
});

test("registry errors name the offending entry", () => {
  for (const [overrides, message] of [
    [{ fixtures: ["agent-missing"] }, /fixture "agent-missing" was not found/],
    [{ mockWorlds: ["moon"] }, /mock world "moon" must be "local" or a world with a package/],
    [{ mockWorlds: ["vercel"] }, /mock world "vercel" must be "local" or a world with a package/],
    [
      {
        models: [
          { name: "alpha", id: "x" },
          { name: "alpha", id: "y" },
        ],
      },
      /duplicate "models" entry "alpha"/,
    ],
    [{ concurrency: undefined }, /"concurrency.legs" must be an integer from 1 to 50/],
    [
      { concurrency: { legs: 5, evalsPerLeg: 0 } },
      /"concurrency.evalsPerLeg" must be an integer from 1 to 16/,
    ],
  ])
    assert.throws(() => select(overrides), message);
});

test("the committed registry is valid", () => {
  const committed = JSON.parse(readFileSync(new URL("../../e2e/benchmark.json", import.meta.url)));
  const committedMatrix = JSON.parse(
    readFileSync(new URL("../../e2e/matrix.json", import.meta.url)),
  );
  const selection = selectBenchmark({
    registry: committed,
    matrix: committedMatrix,
    findFixture: () => ({ dir: "fixture", evalIds: ["eval"] }),
  });
  assert.equal(selection.models.length, committed.models.length);
});

const catalog =
  (data, ok = true) =>
  async () => ({ ok, status: ok ? 200 : 503, json: async () => ({ data }) });

test("pins each model to its catalog release and fails before running on unknown ids", async () => {
  const released = Date.UTC(2026, 8, 22) / 1000;
  const entries = [{ id: "acme/alpha", released }];
  assert.deepEqual(
    await resolveModelReleases([{ name: "alpha", id: "acme/alpha" }], catalog(entries)),
    [{ name: "alpha", id: "acme/alpha", release: "2026-09-22" }],
  );
  await assert.rejects(
    resolveModelReleases([{ name: "beta", id: "acme/beta" }], catalog(entries)),
    /AI Gateway catalog has no model "acme\/beta" \(e2e\/benchmark.json model "beta"\)/,
  );
  await assert.rejects(
    resolveModelReleases([{ name: "alpha", id: "acme/alpha" }], catalog([{ id: "acme/alpha" }])),
    /has no release date to pin/,
  );
});
