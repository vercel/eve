// Plans one benchmark run from e2e/benchmark.json:
//
//   live_matrix  attempt × fixture × model legs on the local world, ordered so
//                the legs running together spread across models
//   max_parallel, evals_per_leg
//                the registry's concurrency caps, which bound gateway load
//                and keep evals from sharing a runner
//   mock_matrix  fixture × mock world legs, one attempt each
//   plan.json    the resolved registry snapshot (models pinned to their AI
//                Gateway release, judge, expected eval ids) plus every leg,
//                handed to the publish job
//
// Dispatch inputs narrow the run through BENCHMARK_MODELS and
// BENCHMARK_FIXTURES (comma-separated registry names) and BENCHMARK_ATTEMPTS.
//
// Usage: node scripts/eval-benchmark/plan.mjs <plan.json> [sha]
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverEvalIds } from "../../.github/scripts/discover-e2e-fixtures.mjs";
import { resolveModelReleases } from "./catalog.mjs";

export const PLAN_SCHEMA_VERSION = 1;
const FIXTURE_ROOTS = ["e2e/fixtures", "apps/fixtures"];
const NAME = /^[a-z0-9-]+$/;
const MAX_ATTEMPTS = 10;
const MAX_PARALLEL_LEGS = 50;
const MAX_EVALS_PER_LEG = 16;

/**
 * Validate the registry and apply dispatch narrowing. Pure apart from the
 * injected fixture lookup, so it is testable without a checkout.
 *
 * @param {{
 *   registry: any,
 *   matrix: any,
 *   findFixture: (name: string) => { dir: string, evalIds: string[], packageJson?: any } | undefined,
 *   narrow?: { models?: string, fixtures?: string, attempts?: string },
 * }} input
 */
export function selectBenchmark({ registry, matrix, findFixture, narrow = {} }) {
  const models = namedEntries(registry?.models, "models");
  if (typeof registry?.judge !== "string" || registry.judge.length === 0)
    throw new Error('e2e/benchmark.json: "judge" must be a non-empty gateway model id.');
  const attempts = positiveInteger(registry?.attempts, 'e2e/benchmark.json: "attempts"');
  const concurrency = {
    legs: boundedInteger(
      registry?.concurrency?.legs,
      MAX_PARALLEL_LEGS,
      'e2e/benchmark.json: "concurrency.legs"',
    ),
    evalsPerLeg: boundedInteger(
      registry?.concurrency?.evalsPerLeg,
      MAX_EVALS_PER_LEG,
      'e2e/benchmark.json: "concurrency.evalsPerLeg"',
    ),
  };
  const fixtureNames = names(registry?.fixtures, "fixtures");
  const mockWorlds = names(registry?.mockWorlds ?? [], "mockWorlds", { allowEmpty: true });
  const matrixWorlds = new Map((matrix?.worlds ?? []).map((world) => [world.name, world]));
  for (const world of mockWorlds) {
    // Mock legs boot a local server, so a non-local world must be a package
    // the fixture can select (EVE_E2E_WORKFLOW_WORLD), not a deploy target.
    if (world !== "local" && matrixWorlds.get(world)?.package === undefined) {
      const packaged = [...matrixWorlds.values()].filter((w) => w.package).map((w) => w.name);
      throw new Error(
        `e2e/benchmark.json: mock world "${world}" must be "local" or a world with a package in e2e/matrix.json (${packaged.join(", ")}).`,
      );
    }
  }

  const fixtures = fixtureNames.map((name) => {
    const found = findFixture(name);
    if (found === undefined) {
      throw new Error(
        `e2e/benchmark.json: fixture "${name}" was not found with an evals/ directory under ${FIXTURE_ROOTS.join(" or ")}.`,
      );
    }
    if (found.evalIds.length === 0)
      throw new Error(`e2e/benchmark.json: fixture "${name}" has no *.eval.ts files.`);
    return { name, ...found };
  });

  const selectedModels = narrowNames(models, narrow.models, "model");
  const selectedFixtures = narrowNames(fixtures, narrow.fixtures, "fixture");
  const selectedAttempts =
    narrow.attempts === undefined || narrow.attempts === ""
      ? attempts
      : positiveInteger(Number(narrow.attempts), "attempts input");

  return {
    judge: registry.judge,
    attempts: selectedAttempts,
    concurrency,
    models: selectedModels,
    fixtures: selectedFixtures,
    mockWorlds: mockWorlds.map((name) => ({ name, package: matrixWorlds.get(name)?.package })),
  };
}

/** Expand a selection into run legs. Leg ids are stable artifact-name suffixes. */
export function planLegs({ models, fixtures, attempts, mockWorlds }) {
  // GitHub starts matrix legs in order and cannot cap concurrency per model,
  // so model-innermost order keeps each wave of legs spread across models and
  // each eval's attempts spread over time.
  const live = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    for (const fixture of fixtures) {
      for (const model of models) {
        live.push(
          leg({ kind: "live", fixture, model_name: model.name, model_id: model.id, attempt }),
        );
      }
    }
  }
  const mock = [];
  for (const fixture of fixtures) {
    const selectedWorlds = fixture.packageJson?.e2e?.worlds;
    for (const world of mockWorlds) {
      // `local` is the default world every fixture boots on; other worlds
      // follow the fixture's own e2e.worlds selection.
      if (
        world.name !== "local" &&
        Array.isArray(selectedWorlds) &&
        !selectedWorlds.includes(world.name)
      )
        continue;
      mock.push(
        leg({ kind: "mock", fixture, model_name: "mock", model_id: "mock", world, attempt: 1 }),
      );
    }
  }
  return { live, mock };
}

function leg({ kind, fixture, model_name, model_id, world = { name: "local" }, attempt }) {
  return {
    // Registry names never contain "_", so "__" keeps ids unambiguous.
    leg_id: [kind, fixture.name, model_name, world.name, attempt].join("__"),
    kind,
    fixture: fixture.name,
    dir: fixture.dir,
    model_name,
    model_id,
    world: world.name,
    world_package: world.package ?? "",
    attempt,
  };
}

function namedEntries(entries, key) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error(`e2e/benchmark.json: "${key}" must be a non-empty array.`);
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry?.name !== "string" || !NAME.test(entry.name))
      throw new Error(`e2e/benchmark.json: every "${key}" entry needs a lowercase-dashed "name".`);
    if (typeof entry.id !== "string" || entry.id.length === 0)
      throw new Error(`e2e/benchmark.json: "${key}" entry "${entry.name}" needs a gateway "id".`);
    if (seen.has(entry.name) || seen.has(entry.id))
      throw new Error(`e2e/benchmark.json: duplicate "${key}" entry "${entry.name}".`);
    seen.add(entry.name).add(entry.id);
  }
  return entries.map(({ name, id }) => ({ name, id }));
}

function names(entries, key, { allowEmpty = false } = {}) {
  if (!Array.isArray(entries) || (!allowEmpty && entries.length === 0))
    throw new Error(`e2e/benchmark.json: "${key}" must be a non-empty array.`);
  if (entries.some((entry) => typeof entry !== "string" || !NAME.test(entry)))
    throw new Error(
      `e2e/benchmark.json: "${key}" entries must be lowercase alphanumerics and dashes.`,
    );
  if (new Set(entries).size !== entries.length)
    throw new Error(`e2e/benchmark.json: "${key}" contains duplicates.`);
  return entries;
}

function positiveInteger(value, label) {
  return boundedInteger(value, MAX_ATTEMPTS, label);
}

function boundedInteger(value, max, label) {
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`${label} must be an integer from 1 to ${max}.`);
  return value;
}

/** An empty input keeps every entry; otherwise every requested name must exist. */
function narrowNames(entries, input, label) {
  if (input === undefined || input.trim() === "") return entries;
  const requested = input
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (requested.length === 1 && requested[0] === "none") return [];
  const known = new Map(entries.map((entry) => [entry.name, entry]));
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown benchmark ${label}${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}; choose from ${[...known.keys()].join(", ")} (or "none").`,
    );
  }
  return requested.map((name) => known.get(name));
}

function findFixtureOnDisk(name) {
  for (const root of FIXTURE_ROOTS) {
    const dir = join(root, name);
    if (!existsSync(join(dir, "evals"))) continue;
    const packageJsonPath = join(dir, "package.json");
    return {
      dir,
      evalIds: discoverEvalIds(join(dir, "evals")),
      packageJson: existsSync(packageJsonPath)
        ? JSON.parse(readFileSync(packageJsonPath, "utf8"))
        : undefined,
    };
  }
  return undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [planPath, shaArgument] = process.argv.slice(2);
  if (planPath === undefined) {
    console.error("Usage: node scripts/eval-benchmark/plan.mjs <plan.json> [sha]");
    process.exit(1);
  }
  const sha =
    shaArgument ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const selection = selectBenchmark({
    registry: JSON.parse(readFileSync("e2e/benchmark.json", "utf8")),
    matrix: JSON.parse(readFileSync("e2e/matrix.json", "utf8")),
    findFixture: findFixtureOnDisk,
    narrow: {
      models: process.env.BENCHMARK_MODELS,
      fixtures: process.env.BENCHMARK_FIXTURES,
      attempts: process.env.BENCHMARK_ATTEMPTS,
    },
  });
  const models = await resolveModelReleases(selection.models, selection.judge);
  const { live, mock } = planLegs({ ...selection, models });
  const plan = {
    schema_version: PLAN_SCHEMA_VERSION,
    sha,
    planned_at: new Date().toISOString(),
    registry: {
      judge: selection.judge,
      attempts: selection.attempts,
      // Concurrency changes measured latency, so every manifest records it.
      concurrency: {
        legs: selection.concurrency.legs,
        evals_per_leg: selection.concurrency.evalsPerLeg,
      },
      models,
      mock_worlds: selection.mockWorlds.map((world) => world.name),
      fixtures: selection.fixtures.map(({ name, dir, evalIds }) => ({
        name,
        dir,
        eval_ids: evalIds,
      })),
    },
    legs: [...live, ...mock],
  };
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const lines = [
    `live_matrix=${JSON.stringify(live)}`,
    `mock_matrix=${JSON.stringify(mock)}`,
    `judge=${selection.judge}`,
    `max_parallel=${selection.concurrency.legs}`,
    `evals_per_leg=${selection.concurrency.evalsPerLeg}`,
  ];
  console.error(`Planned ${live.length} live and ${mock.length} mock legs at ${sha}.`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  else process.stdout.write(`${lines.join("\n")}\n`);
}
