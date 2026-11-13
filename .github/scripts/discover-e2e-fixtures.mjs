// Discover e2e fixture directories for the CI matrices.
//
// Models and worlds live in e2e/matrix.json — edit that file to add either.
//
// A fixture qualifies when it has an `evals/` directory under one of the
// fixture roots. Emits one GitHub Actions output per matrix:
//
//   model_matrix          `{ name, package, dir, model_name, model_id, optional }`
//                         entries for the model suite (e2e-local). Sharded
//                         fixtures expand each selected model into one entry
//                         per exact eval partition. Fixtures
//                         marked `"e2e": { "modelMatrix": "full" }` in
//                         package.json run on every registry model; all other
//                         fixtures run once on the default (first) model. A
//                         fixture may add narrowly scoped model legs through
//                         `additionalModels` and make selected legs non-blocking
//                         through `optionalModels`. A leg runs the fixture's
//                         `real-model` evals on its model (`model_evals`), and
//                         the default model's leg also runs the other evals
//                         with the mock model (`mock_evals`); a fixture without
//                         `real-model` evals gets one mock-only leg. `"e2e":
//                         { "modelSuiteEvals": "all" }` runs every eval on real
//                         models instead, for fixtures that pick models themselves.
//   world_matrix_<world>  `{ name, package, dir[, world_package] }` entries for that
//                         world's suite workflow, which runs fixtures that
//                         select that world once with mock models
//                         (EVE_E2E_MODEL=mock).
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** The tag that marks evals needing a live model; the world suites exclude it. */
const REAL_MODEL_TAG = "real-model";

export function discoverE2eFixtures({ registry, fixtures }) {
  const models = validateNamedEntries(registry.models, "models", ["id"]);
  const worlds = validateNamedEntries(registry.worlds, "worlds", []);
  const normalizedFixtures = fixtures.map((fixture) => normalizeFixture(fixture, worlds));
  if (normalizedFixtures.length === 0) {
    throw new Error("No e2e fixtures with an evals/ directory were found.");
  }

  const modelMatrix = normalizedFixtures.flatMap((fixture) => modelSuiteLegs(fixture, models));

  const outputs = [`model_matrix=${JSON.stringify(modelMatrix)}`];
  for (const world of worlds) {
    const legs = normalizedFixtures
      .filter(({ selectedWorlds }) => selectedWorlds.includes(world.name))
      .map(({ name, packageName, dir }) => {
        const fixture = { name, package: packageName, dir };
        return world.package === undefined ? fixture : { ...fixture, world_package: world.package };
      });
    if (legs.length === 0) {
      throw new Error(`No e2e fixtures select the registered world "${world.name}".`);
    }
    outputs.push(`world_matrix_${world.name}=${JSON.stringify(legs)}`);
  }
  return { lines: `${outputs.join("\n")}\n`, modelMatrix, worlds, fixtures: normalizedFixtures };
}

/**
 * The model-suite legs of one fixture. Its `real-model` evals run on every
 * model it selects; its other evals run once, on the default model's leg, in a
 * second pass with the mock model, so they keep running against the local
 * world and its dev routes. A fixture without `real-model` evals gets one
 * mock-only leg.
 */
function modelSuiteLegs(fixture, models) {
  const { name, packageName, dir, modelMatrix, additionalModels, optionalModels } = fixture;
  const { modelShards, modelSuiteEvals } = fixture;
  const fixtureModels = uniqueModels([
    ...(modelMatrix === "full" ? models : models.slice(0, 1)),
    ...additionalModels,
  ]);
  const selectedNames = new Set(fixtureModels.map((model) => model.name));
  for (const optionalModel of optionalModels) {
    if (!selectedNames.has(optionalModel)) {
      throw new Error(
        `${dir}/package.json: optional model "${optionalModel}" is not selected by this fixture.`,
      );
    }
  }
  const base = { name, package: packageName, dir };
  // Each partition is a shard, or the whole fixture when it isn't sharded.
  const partitions = (modelShards ?? [{ evals: modelSuiteEvals.ids }]).map((shard) => ({
    shard,
    real: modelSuiteEvals.all
      ? shard.evals
      : shard.evals.filter((evalId) => modelSuiteEvals.tagged.includes(evalId)),
    mock: modelSuiteEvals.all
      ? []
      : shard.evals.filter((evalId) => !modelSuiteEvals.tagged.includes(evalId)),
  }));
  const ids = (shard, key, evalIds) => (shard.name === undefined ? {} : { [key]: evalIds });
  const legs = [];
  for (const { shard, real, mock } of partitions) {
    const shardFields = shard.name === undefined ? {} : { shard: shard.name };
    if (real.length === 0) {
      if (mock.length > 0) {
        legs.push({
          ...base,
          model_name: "mock",
          model_id: "mock",
          optional: false,
          model_evals: "none",
          mock_evals: true,
          ...shardFields,
          ...ids(shard, "mock_eval_ids", mock),
        });
      }
      continue;
    }
    for (const [index, model] of fixtureModels.entries()) {
      const withMock = index === 0 && mock.length > 0;
      legs.push({
        ...base,
        model_name: model.name,
        model_id: model.id,
        optional: optionalModels.includes(model.name),
        model_evals: modelSuiteEvals.all ? "all" : REAL_MODEL_TAG,
        mock_evals: withMock,
        ...shardFields,
        ...ids(shard, "eval_ids", real),
        ...(withMock ? ids(shard, "mock_eval_ids", mock) : {}),
      });
    }
  }
  // Keep model-major order: every partition of the first model, then the next.
  return legs.sort(
    (a, b) =>
      fixtureModels.findIndex((model) => model.name === a.model_name) -
      fixtureModels.findIndex((model) => model.name === b.model_name),
  );
}

function normalizeFixture({ name, dir, packageJson, evals = [], realModelEvals = evals }, worlds) {
  const pkg = packageJson ?? {};
  const packageJsonPath = join(dir, "package.json");
  const packageName = validateE2ePackageName(pkg.name, packageJsonPath);
  const selectedWorlds = validateNames(
    pkg.e2e?.worlds ?? worlds.map((world) => world.name),
    `${packageJsonPath}: e2e.worlds`,
  );
  for (const selectedWorld of selectedWorlds) {
    if (!worlds.some((world) => world.name === selectedWorld)) {
      throw new Error(`${packageJsonPath}: unknown e2e world "${selectedWorld}".`);
    }
  }
  const modelMatrix = pkg.e2e?.modelMatrix ?? "default";
  if (modelMatrix !== "default" && modelMatrix !== "full") {
    throw new Error(`${packageJsonPath}: e2e.modelMatrix must be "default" or "full".`);
  }
  const modelShards =
    pkg.e2e?.modelShards === undefined
      ? undefined
      : validateModelShards(pkg.e2e.modelShards, `${packageJsonPath}: e2e.modelShards`, evals);
  const modelSuiteEvals = pkg.e2e?.modelSuiteEvals ?? REAL_MODEL_TAG;
  if (modelSuiteEvals !== REAL_MODEL_TAG && modelSuiteEvals !== "all") {
    throw new Error(
      `${packageJsonPath}: e2e.modelSuiteEvals must be "${REAL_MODEL_TAG}" or "all".`,
    );
  }
  return {
    name,
    packageName,
    dir,
    modelMatrix,
    modelShards,
    modelSuiteEvals: {
      all: modelSuiteEvals === "all",
      ids: evals,
      tagged: evals.filter((evalId) => realModelEvals.includes(evalId)),
    },
    additionalModels: validateNamedEntries(
      pkg.e2e?.additionalModels ?? [],
      `${packageJsonPath}: e2e.additionalModels`,
      ["id"],
      { allowEmpty: true },
    ),
    optionalModels: validateNames(
      pkg.e2e?.optionalModels ?? [],
      `${packageJsonPath}: e2e.optionalModels`,
    ),
    selectedWorlds,
  };
}

function discoverFromDisk() {
  const roots = ["e2e/fixtures", "apps/fixtures"];
  const registry = JSON.parse(readFileSync("e2e/matrix.json", "utf8"));
  const fixtures = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).sort()) {
      const dir = join(root, name);
      if (!statSync(dir).isDirectory() || !existsSync(join(dir, "evals"))) continue;
      const packageJsonPath = join(dir, "package.json");
      fixtures.push({
        name,
        dir,
        evals: discoverEvalIds(join(dir, "evals")),
        realModelEvals: discoverEvalIds(join(dir, "evals"), isRealModelEval),
        packageJson: existsSync(packageJsonPath)
          ? JSON.parse(readFileSync(packageJsonPath, "utf8"))
          : undefined,
      });
    }
  }
  return { registry, fixtures };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = discoverE2eFixtures(discoverFromDisk());
  console.error(
    `Discovered ${result.fixtures.length} fixtures (${result.modelMatrix.length} model-suite jobs, ${result.worlds.length} worlds).`,
  );
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, result.lines);
  else process.stdout.write(result.lines);
}

export function validateE2ePackageName(packageName, packageJsonPath) {
  if (
    typeof packageName !== "string" ||
    packageName.includes("...") ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(packageName)
  ) {
    throw new Error(`${packageJsonPath}: every e2e fixture needs a valid package name.`);
  }
  return packageName;
}

/** Whether an eval file declares the `real-model` tag, which evals write as a literal. */
export function isRealModelEval(source) {
  return /\btags:\s*\[[^\]]*["']real-model["']/u.test(source);
}

export function discoverEvalIds(root, include = () => true) {
  const evalIds = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        entry.isFile() &&
        entry.name.endsWith(".eval.ts") &&
        include(readFileSync(path, "utf8"))
      ) {
        evalIds.push(path.slice(root.length + 1, -".eval.ts".length).replaceAll("\\", "/"));
      }
    }
  };
  visit(root);
  return evalIds;
}

function validateModelShards(shards, key, discoveredEvalIds) {
  if (!Array.isArray(shards) || shards.length === 0) {
    throw new Error(`${key} must be a non-empty array.`);
  }
  const discovered = new Set(discoveredEvalIds);
  const assigned = new Set();
  const names = new Set();
  for (const shard of shards) {
    if (typeof shard?.name !== "string" || !/^[a-z0-9-]+$/.test(shard.name)) {
      throw new Error(`${key} shard names must be non-empty lowercase alphanumerics and dashes.`);
    }
    if (names.has(shard.name))
      throw new Error(`${key} contains duplicate shard name "${shard.name}".`);
    names.add(shard.name);
    if (!Array.isArray(shard.evals) || shard.evals.length === 0) {
      throw new Error(`${key} shard "${shard.name}" must have a non-empty eval list.`);
    }
    for (const evalId of shard.evals) {
      if (typeof evalId !== "string" || evalId.length === 0) {
        throw new Error(`${key} shard "${shard.name}" eval IDs must be non-empty strings.`);
      }
      if (assigned.has(evalId)) throw new Error(`${key} assigns eval "${evalId}" more than once.`);
      assigned.add(evalId);
      if (!discovered.has(evalId)) throw new Error(`${key} references unknown eval "${evalId}".`);
    }
  }
  const unassigned = discoveredEvalIds.filter((evalId) => !assigned.has(evalId));
  if (unassigned.length > 0) {
    throw new Error(
      `${key} does not assign discovered eval${unassigned.length === 1 ? "" : "s"}: ${unassigned.join(", ")}.`,
    );
  }
  return shards;
}

function validateNamedEntries(entries, key, requiredFields, options = {}) {
  if (!Array.isArray(entries) || (entries.length === 0 && options.allowEmpty !== true)) {
    throw new Error(`e2e/matrix.json: "${key}" must be a non-empty array.`);
  }
  const names = new Set();
  for (const entry of entries) {
    for (const field of ["name", ...requiredFields]) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        throw new Error(`e2e/matrix.json: every "${key}" entry needs a non-empty "${field}".`);
      }
    }
    if (!/^[a-z0-9-]+$/.test(entry.name)) {
      throw new Error(
        `e2e/matrix.json: "${key}" name "${entry.name}" must be lowercase alphanumerics and dashes (it becomes a check identifier).`,
      );
    }
    if (names.has(entry.name)) {
      throw new Error(`e2e/matrix.json: duplicate "${key}" name "${entry.name}".`);
    }
    names.add(entry.name);
  }
  return entries;
}

function validateNames(entries, key) {
  if (!Array.isArray(entries)) {
    throw new Error(`${key} must be an array.`);
  }
  const names = new Set();
  for (const entry of entries) {
    if (typeof entry !== "string" || !/^[a-z0-9-]+$/.test(entry)) {
      throw new Error(`${key} entries must be lowercase alphanumerics and dashes.`);
    }
    if (names.has(entry)) {
      throw new Error(`${key} contains duplicate model "${entry}".`);
    }
    names.add(entry);
  }
  return entries;
}

function uniqueModels(entries) {
  const ids = new Set();
  const names = new Set();
  return entries.filter((entry) => {
    if (ids.has(entry.id) || names.has(entry.name)) return false;
    ids.add(entry.id);
    names.add(entry.name);
    return true;
  });
}
