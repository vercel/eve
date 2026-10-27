import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveModelReleases } from "./catalog.mjs";
import { planLegs, selectBenchmark } from "./plan.mjs";
import { evalFlags, releasePublishedAt, releaseTag } from "./release.mjs";

const registry = {
  models: [
    { name: "alpha", id: "acme/alpha" },
    { name: "beta", id: "acme/beta" },
  ],
  fixtures: ["agent-one", "agent-two"],
  mockWorlds: ["local", "postgres"],
  attempts: 2,
  mockAttempts: 2,
  devStartup: { runs: 3, subjects: ["minimal"] },
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
  "agent-stress": { dir: "e2e/fixtures/agent-stress", evalIds: ["s"] },
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
  assert.deepEqual(selection.devStartup, { runs: 3, subjects: [{ name: "minimal", tools: 0 }] });
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
    hosted: false,
    attempt: 1,
  });
  assert.equal(new Set(live.map((leg) => leg.leg_id)).size, live.length);
  assert.deepEqual(
    mock.map((leg) => [leg.leg_id, leg.world_package]),
    [
      ["mock__agent-one__mock__local__1", ""],
      ["mock__agent-one__mock__postgres__1", "@workflow/world-postgres"],
      ["mock__agent-two__mock__local__1", ""],
      ["mock__agent-one__mock__local__2", ""],
      ["mock__agent-one__mock__postgres__2", "@workflow/world-postgres"],
      ["mock__agent-two__mock__local__2", ""],
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

test("mockFixtures limits mock legs without touching live legs", () => {
  const selection = select({ mockFixtures: ["agent-two"] });
  const { live, mock } = planLegs(selection);
  assert.equal(live.length, 2 * 2 * 2);
  assert.deepEqual(
    mock.map((leg) => leg.leg_id),
    ["mock__agent-two__mock__local__1", "mock__agent-two__mock__local__2"],
  );
  // Dispatch narrowing still applies to mock fixtures.
  assert.deepEqual(
    planLegs(select({ mockFixtures: ["agent-two"] }, { fixtures: "agent-one" })).mock,
    [],
  );
});

test("mock-only fixtures and hosted worlds plan without live legs", () => {
  const selection = select({
    mockFixtures: ["agent-one", "agent-stress"],
    mockWorlds: ["local", { name: "vercel", fixtures: ["agent-stress"] }],
    mockAttempts: 1,
  });
  const { live, mock } = planLegs(selection);
  assert.ok(live.every((leg) => leg.fixture !== "agent-stress"));
  assert.deepEqual(
    mock.map((leg) => [leg.leg_id, leg.hosted]),
    [
      ["mock__agent-one__mock__local__1", false],
      ["mock__agent-stress__mock__local__1", false],
      ["mock__agent-stress__mock__vercel__1", true],
    ],
  );
  // Narrowing to a mock-only fixture leaves no live legs.
  assert.deepEqual(
    planLegs(
      select(
        { mockFixtures: ["agent-stress"], mockWorlds: [{ name: "vercel" }] },
        { fixtures: "agent-stress" },
      ),
    ).live,
    [],
  );
});

test("a backfill plans the fixtures its release has and no hosted worlds", () => {
  const selection = selectBenchmark({
    registry: {
      ...registry,
      fixtures: ["agent-one", "agent-new"],
      mockFixtures: ["agent-one", "agent-stress"],
      mockWorlds: ["local", "postgres", { name: "vercel", fixtures: ["agent-stress"] }],
      mockAttempts: 1,
    },
    matrix,
    // The release predates agent-new.
    findFixture: (name) => fixtures[name],
    backfill: true,
  });
  assert.deepEqual(selection.absentFixtures, ["agent-new"]);
  const { live, mock } = planLegs(selection);
  assert.deepEqual([...new Set(live.map((leg) => leg.fixture))], ["agent-one"]);
  assert.deepEqual(
    mock.map((leg) => leg.leg_id),
    [
      "mock__agent-one__mock__local__1",
      "mock__agent-one__mock__postgres__1",
      "mock__agent-stress__mock__local__1",
      "mock__agent-stress__mock__postgres__1",
    ],
  );
});

test("dates a backfill at its npm publish time and passes only flags its runner has", async () => {
  const npm = (time) => async () => ({ ok: true, status: 200, json: async () => ({ time }) });
  assert.equal(
    await releasePublishedAt("0.61.0", npm({ "0.61.0": "2026-09-18T17:49:48.172Z" })),
    "2026-09-18T17:49:48.172Z",
  );
  await assert.rejects(
    releasePublishedAt("0.61.9", npm({})),
    /npm has no publish time for eve 0.61.9/,
  );
  // Numeric, not lexical: 0.9.0 is older than 0.83.1.
  assert.deepEqual(
    ["0.9.0", "0.83.0", "0.83.1", "0.100.0"].map((version) => evalFlags(version).keepState),
    [false, false, true, true],
  );
  assert.equal(releaseTag("0.61.0"), "eve@0.61.0");
  assert.throws(() => releaseTag("eve@0.61.0"), /must be a published eve version/);
});

test("registry errors name the offending entry", () => {
  for (const [overrides, message] of [
    [{ fixtures: ["agent-missing"] }, /fixture "agent-missing" was not found/],
    [{ mockWorlds: ["moon"] }, /mock world "moon" must be "local" or a world in e2e\/matrix.json/],
    [
      { mockWorlds: [{ name: "vercel", fixtures: ["agent-three"] }] },
      /mock world "vercel" fixtures must be mock fixtures \(agent-three\)/,
    ],
    [{ mockWorlds: ["local", "local"] }, /"mockWorlds" contains duplicates/],
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
    [{ mockAttempts: 0 }, /"mockAttempts" must be an integer from 1 to 10/],
    [{ mockFixtures: ["agent-three"] }, /fixture "agent-three" was not found/],
    [
      { devStartup: { runs: 3, subjects: ["kitchen-sink"] } },
      /unknown "devStartup.subjects" kitchen-sink/,
    ],
    [{ devStartup: { runs: 1, subjects: ["minimal"] } }, /must include a warm run/],
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
