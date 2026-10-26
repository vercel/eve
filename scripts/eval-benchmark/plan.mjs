// Plans one benchmark run from e2e/benchmark.json:
//
//   live_matrix  attempt × fixture × model legs on the local world, ordered so
//                the legs running together spread across models
//   max_parallel, evals_per_leg
//                the registry's concurrency caps, which bound gateway load
//                and keep evals from sharing a runner
//   mock_matrix  attempt × mock fixture × mock world legs (`mockAttempts` each:
//                one sample is exact for durable-work counters, but too few
//                for timing trends) on a local server
//   hosted_matrix  the mock legs on a hosted world (a preview deployment
//                each), run one at a time so they don't contend for the
//                same deployment backend
//   dev_startup  `eve dev` startup probe settings (runs and named agents) for
//                the dev-startup job, or null when the registry has none
//   plan.json    the resolved registry snapshot (models pinned to their AI
//                Gateway release, fixture digests, expected eval ids) plus
//                every leg,
//                handed to the publish job
//
// Dispatch inputs narrow the run through BENCHMARK_MODELS and
// BENCHMARK_FIXTURES (comma-separated registry names) and BENCHMARK_ATTEMPTS.
// BENCHMARK_RELEASE (e.g. 0.61.0) plans a release backfill (release.mjs):
// the run is dated at the release's npm publish time, its manifest names the
// release as its `source`, and it skips hosted worlds, whose platform the
// release does not pin.
//
// The working directory is the code under test (main, or the release's tag),
// which supplies the fixtures and e2e/matrix.json. The registry and the
// startup probe are always this script's own checkout (the harness).
//
// Usage: node scripts/eval-benchmark/plan.mjs <plan.json> [sha]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverEvalIds } from "../../.github/scripts/discover-e2e-fixtures.mjs";
import { resolveModelReleases } from "./catalog.mjs";
import { fixtureDigest } from "./digest.mjs";
import { evalFlags, releasePublishedAt, releaseTag } from "./release.mjs";

export const PLAN_SCHEMA_VERSION = 1;
const HARNESS_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE_ROOTS = ["e2e/fixtures", "apps/fixtures"];
const NAME = /^[a-z0-9-]+$/;
const MAX_ATTEMPTS = 10;
const MAX_PARALLEL_LEGS = 50;
const MAX_EVALS_PER_LEG = 16;
const MAX_STARTUP_RUNS = 10;
// Agents packages/eve/scripts/benchmark-startup.mjs generates, by registry name.
const STARTUP_SCRIPT = "packages/eve/scripts/benchmark-startup.mjs";
const STARTUP_SUBJECTS = { minimal: { tools: 0 } };

/**
 * Validate the registry and apply dispatch narrowing. Pure apart from the
 * injected fixture lookup, so it is testable without a checkout.
 *
 * @param {{
 *   registry: any,
 *   matrix: any,
 *   findFixture: (name: string) => { dir: string, evalIds: string[], packageJson?: any } | undefined,
 *   narrow?: { models?: string, fixtures?: string, attempts?: string },
 *   backfill?: boolean,
 * }} input `backfill` plans a release backfill: registry fixtures the
 *   release predates are left out (listed as `absentFixtures`), and so are
 *   hosted worlds, whose platform the release does not pin.
 */
export function selectBenchmark({ registry, matrix, findFixture, narrow = {}, backfill = false }) {
  const models = namedEntries(registry?.models, "models");
  const attempts = positiveInteger(registry?.attempts, 'e2e/benchmark.json: "attempts"');
  const mockAttempts = positiveInteger(
    registry?.mockAttempts,
    'e2e/benchmark.json: "mockAttempts"',
  );
  const devStartup =
    registry?.devStartup === undefined ? null : readDevStartup(registry.devStartup);
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
  // A fixture whose evals all need a real model runs nothing on a mock leg;
  // one scripted for the mock model (agent-workflow-stress) runs only there.
  const mockFixtureNames =
    registry?.mockFixtures === undefined
      ? fixtureNames
      : names(registry.mockFixtures, "mockFixtures", { allowEmpty: true });
  const mockWorlds = readMockWorlds(registry?.mockWorlds ?? [], matrix, mockFixtureNames).filter(
    (world) => !(backfill && world.hosted),
  );

  const plannedNames = [...new Set([...fixtureNames, ...mockFixtureNames])];
  const absentFixtures = [];
  const fixtures = plannedNames.flatMap((name) => {
    const found = findFixture(name);
    if (found === undefined && backfill) {
      absentFixtures.push(name);
      return [];
    }
    if (found === undefined) {
      throw new Error(
        `e2e/benchmark.json: fixture "${name}" was not found with an evals/ directory under ${FIXTURE_ROOTS.join(" or ")}.`,
      );
    }
    if (found.evalIds.length === 0)
      throw new Error(`e2e/benchmark.json: fixture "${name}" has no *.eval.ts files.`);
    return [{ name, ...found }];
  });

  const selectedModels = narrowNames(models, narrow.models, "model");
  const selectedFixtures = narrowNames(fixtures, narrow.fixtures, "fixture");
  const selectedNames = new Set(selectedFixtures.map(({ name }) => name));
  const selectedAttempts =
    narrow.attempts === undefined || narrow.attempts === ""
      ? attempts
      : positiveInteger(Number(narrow.attempts), "attempts input");

  return {
    attempts: selectedAttempts,
    mockAttempts,
    devStartup,
    concurrency,
    models: selectedModels,
    fixtures: fixtures.filter(({ name }) => selectedNames.has(name) && fixtureNames.includes(name)),
    mockFixtures: fixtures.filter(
      ({ name }) => selectedNames.has(name) && mockFixtureNames.includes(name),
    ),
    mockWorlds,
    absentFixtures,
  };
}

/**
 * Mock worlds are `local`, a world package from e2e/matrix.json that a local
 * production server selects (EVE_E2E_WORKFLOW_WORLD), or a matrix world with
 * no package, which is a deploy target (`hosted`: `vercel`). An entry may be
 * `{ name, fixtures }` to run only some mock fixtures there; each hosted leg
 * is a deployment, so hosted worlds usually list a few.
 */
function readMockWorlds(entries, matrix, mockFixtureNames) {
  if (!Array.isArray(entries))
    throw new Error('e2e/benchmark.json: "mockWorlds" must be an array.');
  const matrixWorlds = new Map((matrix?.worlds ?? []).map((world) => [world.name, world]));
  const worlds = entries.map((entry) => {
    const { name, fixtures } = typeof entry === "string" ? { name: entry } : (entry ?? {});
    if (typeof name !== "string" || !NAME.test(name))
      throw new Error(
        'e2e/benchmark.json: every "mockWorlds" entry needs a lowercase-dashed name.',
      );
    if (name !== "local" && !matrixWorlds.has(name))
      throw new Error(
        `e2e/benchmark.json: mock world "${name}" must be "local" or a world in e2e/matrix.json (${[...matrixWorlds.keys()].join(", ")}).`,
      );
    if (fixtures !== undefined) {
      const unknown = names(fixtures, `mockWorlds.${name}.fixtures`).filter(
        (fixture) => !mockFixtureNames.includes(fixture),
      );
      if (unknown.length > 0)
        throw new Error(
          `e2e/benchmark.json: mock world "${name}" fixtures must be mock fixtures (${unknown.join(", ")}).`,
        );
    }
    const pkg = matrixWorlds.get(name)?.package;
    return { name, package: pkg, hosted: name !== "local" && pkg === undefined, fixtures };
  });
  if (new Set(worlds.map((world) => world.name)).size !== worlds.length)
    throw new Error('e2e/benchmark.json: "mockWorlds" contains duplicates.');
  return worlds;
}

/** Expand a selection into run legs. Leg ids are stable artifact-name suffixes. */
export function planLegs({
  models,
  fixtures,
  attempts,
  mockAttempts = 1,
  mockFixtures = fixtures,
  mockWorlds,
}) {
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
  for (let attempt = 1; attempt <= mockAttempts; attempt += 1) {
    for (const fixture of mockFixtures) {
      const selectedWorlds = fixture.packageJson?.e2e?.worlds;
      for (const world of mockWorlds) {
        if (world.fixtures !== undefined && !world.fixtures.includes(fixture.name)) continue;
        // `local` is the default world every fixture boots on; other worlds
        // follow the fixture's own e2e.worlds selection.
        if (
          world.name !== "local" &&
          Array.isArray(selectedWorlds) &&
          !selectedWorlds.includes(world.name)
        )
          continue;
        mock.push(
          leg({ kind: "mock", fixture, model_name: "mock", model_id: "mock", world, attempt }),
        );
      }
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
    hosted: world.hosted === true,
    attempt,
  };
}

/**
 * Startup probe subjects are agents the startup script generates, by name.
 * Run 1 of each starts from an empty project (cold); later runs reuse its
 * caches (warm), so `runs` must leave at least one warm run.
 */
function readDevStartup(value) {
  const runs = boundedInteger(
    value?.runs,
    MAX_STARTUP_RUNS,
    'e2e/benchmark.json: "devStartup.runs"',
  );
  if (runs < 2)
    throw new Error(
      'e2e/benchmark.json: "devStartup.runs" must include a warm run after the cold one.',
    );
  const subjects = names(value?.subjects, "devStartup.subjects");
  const unknown = subjects.filter((name) => !Object.hasOwn(STARTUP_SUBJECTS, name));
  if (unknown.length > 0)
    throw new Error(
      `e2e/benchmark.json: unknown "devStartup.subjects" ${unknown.join(", ")}; choose from ${Object.keys(STARTUP_SUBJECTS).join(", ")}.`,
    );
  return { runs, subjects: subjects.map((name) => ({ name, ...STARTUP_SUBJECTS[name] })) };
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
  if (new Set(requested).size !== requested.length)
    throw new Error(`Benchmark ${label} input "${input}" contains duplicates.`);
  const known = new Map(entries.map((entry) => [entry.name, entry]));
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown benchmark ${label}${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}; choose from ${[...known.keys()].join(", ")} (or "none").`,
    );
  }
  return requested.map((name) => known.get(name));
}

/** git's blob id for a file: `git rev-parse <commit>:<path>` for the committed file. */
function gitBlobId(path) {
  const body = readFileSync(path);
  return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
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
  const gitHead = (cwd) =>
    execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const sha = shaArgument ?? gitHead(".");
  const release = process.env.BENCHMARK_RELEASE || undefined;
  const eveVersion = JSON.parse(readFileSync("packages/eve/package.json", "utf8")).version;
  if (release !== undefined && eveVersion !== release)
    throw new Error(
      `The checkout at ${sha} is eve ${eveVersion}, not ${releaseTag(release)}; check out the release's tag to backfill it.`,
    );
  const selection = selectBenchmark({
    registry: JSON.parse(readFileSync(join(HARNESS_ROOT, "e2e/benchmark.json"), "utf8")),
    matrix: JSON.parse(readFileSync("e2e/matrix.json", "utf8")),
    findFixture: findFixtureOnDisk,
    narrow: {
      models: process.env.BENCHMARK_MODELS,
      fixtures: process.env.BENCHMARK_FIXTURES,
      attempts: process.env.BENCHMARK_ATTEMPTS,
    },
    backfill: release !== undefined,
  });
  if (selection.absentFixtures.length > 0)
    console.error(
      `eve ${eveVersion} predates registry fixtures ${selection.absentFixtures.join(", ")}; they are not planned.`,
    );
  const models = await resolveModelReleases(selection.models);
  const { live, mock } = planLegs({ ...selection, models });
  const plannedAt =
    release === undefined ? new Date().toISOString() : await releasePublishedAt(release);
  // main's eval runner has every flag the benchmark passes.
  const flags = release === undefined ? { keepState: true } : evalFlags(release);
  const plan = {
    schema_version: PLAN_SCHEMA_VERSION,
    sha,
    eve_version: eveVersion,
    planned_at: plannedAt,
    ...(release === undefined
      ? {}
      : {
          source: {
            kind: "release-backfill",
            repository: process.env.GITHUB_REPOSITORY ?? null,
            release,
            tag: releaseTag(release),
            published_at: plannedAt,
            executed_at: new Date().toISOString(),
            harness_sha: gitHead(HARNESS_ROOT),
          },
        }),
    registry: {
      attempts: selection.attempts,
      mock_attempts: selection.mockAttempts,
      // The startup script defines its agents, so its blob id is their digest.
      // The harness runs it, so a backfill shares main's digest.
      dev_startup:
        selection.devStartup === null
          ? null
          : {
              ...selection.devStartup,
              subjects: selection.devStartup.subjects.map((subject) => ({
                ...subject,
                digest: gitBlobId(join(HARNESS_ROOT, STARTUP_SCRIPT)),
              })),
            },
      // Concurrency changes measured latency, so every manifest records it.
      concurrency: {
        legs: selection.concurrency.legs,
        evals_per_leg: selection.concurrency.evalsPerLeg,
      },
      models,
      mock_worlds: selection.mockWorlds.map((world) => world.name),
      mock_fixtures: selection.mockFixtures.map((fixture) => fixture.name),
      // Live and mock fixtures alike; records read each one's digest here.
      fixtures: [
        ...new Map(
          [...selection.fixtures, ...selection.mockFixtures].map((fixture) => [
            fixture.name,
            fixture,
          ]),
        ).values(),
      ].map(({ name, dir, evalIds }) => ({
        name,
        dir,
        digest: fixtureDigest(sha, dir),
        eval_ids: evalIds,
      })),
    },
    legs: [...live, ...mock],
  };
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const lines = [
    `live_matrix=${JSON.stringify(live)}`,
    `mock_matrix=${JSON.stringify(mock.filter((leg) => !leg.hosted))}`,
    `hosted_matrix=${JSON.stringify(mock.filter((leg) => leg.hosted))}`,
    `dev_startup=${JSON.stringify(selection.devStartup)}`,
    `max_parallel=${selection.concurrency.legs}`,
    `evals_per_leg=${selection.concurrency.evalsPerLeg}`,
    `keep_state=${flags.keepState}`,
  ];
  console.error(
    `Planned ${live.length} live and ${mock.length} mock legs at ${sha} (eve ${eveVersion}${release === undefined ? "" : `, dated ${plannedAt}`}).`,
  );
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  else process.stdout.write(`${lines.join("\n")}\n`);
}
