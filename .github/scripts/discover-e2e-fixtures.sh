#!/usr/bin/env bash
# Discover e2e fixture directories for the CI matrices.
#
# A fixture qualifies when it has an `evals/` directory under one of the
# fixture roots. Emits two GitHub Actions outputs:
#
#   model_matrix  `{ name, dir, model_name, model_id }` entries for the model
#                 suite (e2e-local). Fixtures marked `"e2e": { "modelMatrix":
#                 "full" }` in package.json run on every matrix model; all
#                 other fixtures run once on the default model.
#   world_matrix  `{ name, dir }` entries for the world suites (e2e-vercel,
#                 e2e-postgres), which run every fixture once with mock
#                 models (EVE_E2E_MODEL=mock).
set -euo pipefail

node <<'NODE' >>"${GITHUB_OUTPUT:-/dev/stdout}"
const { readdirSync, readFileSync, statSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const roots = ["e2e/fixtures", "apps/fixtures"];

// The model suite's matrix models. The first entry is the default model that
// every fixture runs on; fixtures whose behavior varies per provider opt into
// the full list with `"e2e": { "modelMatrix": "full" }` in package.json.
const models = [
  { name: "openai-sol", id: "openai/gpt-5.6-sol" },
  { name: "anthropic-opus", id: "anthropic/claude-opus-5" },
];

const fixtures = [];
for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, "evals"))) continue;

    let modelMatrix = "default";
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      modelMatrix = pkg.e2e?.modelMatrix ?? "default";
    }
    if (modelMatrix !== "default" && modelMatrix !== "full") {
      throw new Error(`${packageJsonPath}: e2e.modelMatrix must be "default" or "full".`);
    }

    fixtures.push({ name: entry, dir, modelMatrix });
  }
}

if (fixtures.length === 0) {
  console.error("No e2e fixtures with an evals/ directory were found.");
  process.exit(1);
}

const modelMatrix = fixtures.flatMap(({ name, dir, modelMatrix }) =>
  (modelMatrix === "full" ? models : models.slice(0, 1)).map((model) => ({
    name,
    dir,
    model_name: model.name,
    model_id: model.id,
  })),
);
const worldMatrix = fixtures.map(({ name, dir }) => ({ name, dir }));

console.error(`Discovered ${fixtures.length} fixtures (${modelMatrix.length} model-suite jobs).`);
console.log(`model_matrix=${JSON.stringify(modelMatrix)}`);
console.log(`world_matrix=${JSON.stringify(worldMatrix)}`);
NODE
