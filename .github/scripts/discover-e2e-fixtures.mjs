// Discover e2e fixture directories for the CI matrices.
//
// Models and worlds live in e2e/matrix.json — edit that file to add either.
//
// A fixture qualifies when it has an `evals/` directory under one of the
// fixture roots. Emits one GitHub Actions output per matrix:
//
//   model_matrix          `{ name, dir, model_name, model_id }` entries for
//                         the model suite (e2e-local). Fixtures marked
//                         `"e2e": { "modelMatrix": "full" }` in package.json
//                         run on every registry model; all other fixtures run
//                         once on the default (first) model. A fixture may add
//                         narrowly scoped model legs through `additionalModels`.
//   world_matrix_<world>  `{ name, dir[, world_package] }` entries for that
//                         world's suite workflow, which runs every fixture
//                         once with mock models (EVE_E2E_MODEL=mock).
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["e2e/fixtures", "apps/fixtures"];

const registry = JSON.parse(readFileSync("e2e/matrix.json", "utf8"));
const models = validateNamedEntries(registry.models, "models", ["id"]);
const worlds = validateNamedEntries(registry.worlds, "worlds", []);

const fixtures = [];
for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, "evals"))) continue;

    let modelMatrix = "default";
    let additionalModels = [];
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      modelMatrix = pkg.e2e?.modelMatrix ?? "default";
      additionalModels = validateNamedEntries(
        pkg.e2e?.additionalModels ?? [],
        `${packageJsonPath}: e2e.additionalModels`,
        ["id"],
        { allowEmpty: true },
      );
    }
    if (modelMatrix !== "default" && modelMatrix !== "full") {
      throw new Error(`${packageJsonPath}: e2e.modelMatrix must be "default" or "full".`);
    }

    fixtures.push({ name: entry, dir, modelMatrix, additionalModels });
  }
}

if (fixtures.length === 0) {
  console.error("No e2e fixtures with an evals/ directory were found.");
  process.exit(1);
}

const modelMatrix = fixtures.flatMap(({ name, dir, modelMatrix, additionalModels }) =>
  uniqueModels([
    ...(modelMatrix === "full" ? models : models.slice(0, 1)),
    ...additionalModels,
  ]).map((model) => ({
    name,
    dir,
    model_name: model.name,
    model_id: model.id,
  })),
);

const outputs = [`model_matrix=${JSON.stringify(modelMatrix)}`];
for (const world of worlds) {
  const legs = fixtures.map(({ name, dir }) =>
    world.package === undefined ? { name, dir } : { name, dir, world_package: world.package },
  );
  outputs.push(`world_matrix_${world.name}=${JSON.stringify(legs)}`);
}

console.error(
  `Discovered ${fixtures.length} fixtures (${modelMatrix.length} model-suite jobs, ${worlds.length} worlds).`,
);
const lines = `${outputs.join("\n")}\n`;
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, lines);
} else {
  process.stdout.write(lines);
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
