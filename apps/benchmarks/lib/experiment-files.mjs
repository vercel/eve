import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createJiti } from "jiti";

export function fixtureNames(evalsRoot) {
  return readdirSync(evalsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(evalsRoot, entry.name, "CASE.ts")))
    .map((entry) => entry.name)
    .sort();
}

export async function prepareFixtures(evalsRoot, subject, names = fixtureNames(evalsRoot)) {
  for (const name of names) {
    const fixtureRoot = join(evalsRoot, name);
    const authoringCase = await loadCase(fixtureRoot);
    writeFileSync(
      join(fixtureRoot, "PROMPT.md"),
      `${await promptForCase(authoringCase, fixtureRoot)}\n`,
    );
    writeFileSync(
      join(fixtureRoot, ".eve-authoring-bootstrap.json"),
      `${JSON.stringify({
        startingPoint: authoringCase.startingPoint.workspace,
        projectDirectory: authoringCase.projectDirectory,
        revision: subject.revision,
        setupIds: [authoringCase.startingPoint.setup, authoringCase.setup]
          .filter(Boolean)
          .map((setup) => setup.id),
      })}\n`,
    );
    writeFileSync(
      join(fixtureRoot, "package.json"),
      `${JSON.stringify({ name: `eve-authoring-${name}`, private: true, type: "module" }, null, 2)}\n`,
    );
  }
}

async function loadCase(fixtureRoot) {
  const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  let authoringCase = await jiti.import(`${fixtureRoot}/CASE.ts`);
  while (!isAuthoringCase(authoringCase) && hasDefaultExport(authoringCase)) {
    authoringCase = authoringCase.default;
  }
  if (!isAuthoringCase(authoringCase)) {
    throw new Error(`${fixtureRoot}/CASE.ts must export an authoring case as default.`);
  }
  return authoringCase;
}

async function promptForCase(authoringCase, fixtureRoot) {
  const prompts = [];
  await authoringCase.interact({
    send: async (prompt) => {
      prompts.push(prompt);
      return { text: "", toolCalls: [] };
    },
  });
  if (prompts.length !== 1) {
    throw new Error(
      `${fixtureRoot}/CASE.ts is multi-turn and cannot run on a native agent-eval runner.`,
    );
  }
  return prompts[0];
}

function isAuthoringCase(value) {
  return typeof value === "object" && value !== null && typeof value.interact === "function";
}

function hasDefaultExport(value) {
  return typeof value === "object" && value !== null && "default" in value;
}

export function resetExperiments(experimentsRoot) {
  rmSync(experimentsRoot, { recursive: true, force: true });
  mkdirSync(experimentsRoot, { recursive: true });
}

export function writeExperiment(experimentsRoot, name, options) {
  writeFileSync(
    join(experimentsRoot, `${name}.ts`),
    `import { authoringExperiment } from "../lib/experiment.js";\n\n` +
      `export default authoringExperiment({\n` +
      `  revision: ${JSON.stringify(options.revision)},\n` +
      `  packageSpec: ${JSON.stringify(options.packageSpec)},\n` +
      `  runs: ${options.runs},\n` +
      (options.evals === undefined ? "" : `  evals: ${JSON.stringify(options.evals)},\n`) +
      `  benchmark: ${JSON.stringify(options.benchmark)},\n` +
      `  treatment: ${JSON.stringify(options.treatment)},\n` +
      (options.verbose === undefined ? "" : `  verbose: ${options.verbose},\n`) +
      `});\n`,
  );
}
