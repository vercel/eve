import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveModelReleases } from "./catalog.mjs";
import { evalDigests } from "./digest.mjs";
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
  judge: "acme/judge",
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
    [{ judge: "" }, /"judge" must be a non-empty gateway model id/],
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
  assert.equal(selection.judge, committed.judge);
});

const catalog =
  (data, ok = true) =>
  async () => ({ ok, status: ok ? 200 : 503, json: async () => ({ data }) });

test("pins each model to its catalog release and fails before running on unknown ids", async () => {
  const released = Date.UTC(2026, 8, 22) / 1000;
  const entries = [
    { id: "acme/alpha", released },
    { id: "acme/judge", released },
  ];
  assert.deepEqual(
    await resolveModelReleases(
      [{ name: "alpha", id: "acme/alpha" }],
      "acme/judge",
      catalog(entries),
    ),
    [{ name: "alpha", id: "acme/alpha", release: "2026-09-22" }],
  );
  await assert.rejects(
    resolveModelReleases([{ name: "beta", id: "acme/beta" }], "acme/judge", catalog(entries)),
    /AI Gateway catalog has no model "acme\/beta" \(e2e\/benchmark.json model "beta"\)/,
  );
  await assert.rejects(
    resolveModelReleases([], "acme/other-judge", catalog(entries)),
    /no judge model "acme\/other-judge"/,
  );
  await assert.rejects(
    resolveModelReleases(
      [{ name: "alpha", id: "acme/alpha" }],
      "acme/judge",
      catalog([{ id: "acme/alpha" }, { id: "acme/judge" }]),
    ),
    /has no release date to pin/,
  );
  await assert.rejects(
    resolveModelReleases([], "acme/judge", catalog([], false)),
    /request failed \(503\)/,
  );
});

test("eval digests change with the eval file or its fixture, not with other evals", () => {
  const objects = {
    "e2e/fixtures/agent-one/evals/a.eval.ts": "1",
    "e2e/fixtures/agent-one/evals/b.eval.ts": "2",
    "e2e/fixtures/agent-one/agent": "3",
    "e2e/fixtures/agent-one/package.json": "4",
    "e2e/fixtures/e2e-config": "5",
  };
  const digest = (overrides = {}) =>
    evalDigests({
      sha: "sha",
      fixtureDir: "e2e/fixtures/agent-one",
      evalIds: ["a", "b", "b/0"],
      resolve: (specs) =>
        new Map(
          specs.flatMap((spec) => {
            const id = { ...objects, ...overrides }[spec.slice("sha:".length)];
            return id === undefined ? [] : [[spec, id]];
          }),
        ),
    });
  const base = digest();
  assert.match(base.get("a"), /^[0-9a-f]{64}$/);
  assert.equal(base.get("b/0"), base.get("b"), "array entries resolve to their file");
  const editedEval = digest({ "e2e/fixtures/agent-one/evals/b.eval.ts": "changed" });
  assert.equal(editedEval.get("a"), base.get("a"));
  assert.notEqual(editedEval.get("b"), base.get("b"));
  const editedAgent = digest({ "e2e/fixtures/agent-one/agent": "changed" });
  assert.notEqual(editedAgent.get("a"), base.get("a"));
});
