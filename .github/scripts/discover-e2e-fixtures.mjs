// Discover e2e fixture directories for the CI matrices.
//
// Models and worlds live in e2e/matrix.json — edit that file to add either.
//
// A fixture qualifies when it has an `evals/` directory under one of the
// fixture roots. Emits one GitHub Actions output per matrix:
//
//   model_matrix          `{ name, dir, model_name, model_id, optional }`
//                         entries for the model suite (e2e-local). Fixtures
//                         marked `"e2e": { "modelMatrix": "full" }` in
//                         package.json run on every registry model; all other
//                         fixtures run once on the default (first) model. A
//                         fixture may add narrowly scoped model legs through
//                         `additionalModels` and make selected legs non-blocking
//                         through `optionalModels`.
//   world_matrix_<world>  `{ name, dir[, world_package] }` entries for that
//                         world's suite workflow, which runs fixtures that
//                         select that world once with mock models
//                         (EVE_E2E_MODEL=mock).
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export function discoverE2eFixtures({ registry, fixtures }) {
  const models = validateNamedEntries(registry.models, "models", ["id"]);
  const worlds = validateNamedEntries(registry.worlds, "worlds", []);
  const normalizedFixtures = fixtures.map((fixture) => normalizeFixture(fixture, worlds));
  if (normalizedFixtures.length === 0) {
    throw new Error("No e2e fixtures with an evals/ directory were found.");
  }

  const modelMatrix = normalizedFixtures.flatMap(
    ({ name, dir, modelMatrix, additionalModels, optionalModels }) => {
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
      return fixtureModels.map((model) => ({
        name,
        dir,
        model_name: model.name,
        model_id: model.id,
        optional: optionalModels.includes(model.name),
      }));
    },
  );

  const outputs = [`model_matrix=${JSON.stringify(modelMatrix)}`];
  for (const world of worlds) {
    const legs = normalizedFixtures
      .filter(({ selectedWorlds }) => selectedWorlds.includes(world.name))
      .map(({ name, dir }) =>
        world.package === undefined ? { name, dir } : { name, dir, world_package: world.package },
      );
    outputs.push(`world_matrix_${world.name}=${JSON.stringify(legs)}`);
  }
  return { lines: `${outputs.join("\n")}\n`, modelMatrix, worlds, fixtures: normalizedFixtures };
}

function normalizeFixture({ name, dir, packageJson }, worlds) {
  const pkg = packageJson ?? {};
  const packageJsonPath = join(dir, "package.json");
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
  return {
    name,
    dir,
    modelMatrix,
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
