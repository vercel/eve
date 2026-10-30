import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createJiti } from "jiti";

/** Files `prepareFixtures` writes into each case directory (gitignored, not part of the case). */
export const generatedFixtureFiles = ["PROMPT.md", ".eve-authoring-bootstrap.json", "package.json"];

export function fixtureNames(evalsRoot) {
  return readdirSync(evalsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(evalsRoot, entry.name, "CASE.ts")))
    .map((entry) => entry.name)
    .sort();
}

/** Fixtures the native agent-eval runner can run, which excludes multi-turn cases. */
export async function nativeFixtureNames(evalsRoot) {
  const names = [];
  for (const name of fixtureNames(evalsRoot)) {
    const prompts = await casePrompts(await loadCase(join(evalsRoot, name)));
    if (prompts.length === 1) names.push(name);
  }
  return names;
}

export async function prepareFixtures(evalsRoot, subject, names = fixtureNames(evalsRoot)) {
  let timeoutSeconds;
  for (const name of names) {
    const fixtureRoot = join(evalsRoot, name);
    const authoringCase = await loadCase(fixtureRoot);
    if (authoringCase.timeoutSeconds !== undefined) {
      timeoutSeconds = Math.max(timeoutSeconds ?? 0, authoringCase.timeoutSeconds);
    }
    writeFileSync(
      join(fixtureRoot, "PROMPT.md"),
      `${await promptForCase(authoringCase, fixtureRoot)}\n`,
    );
    writeFileSync(
      join(fixtureRoot, ".eve-authoring-bootstrap.json"),
      `${JSON.stringify({
        startingPoint: authoringCase.startingPoint.workspace,
        projectDirectory: authoringCase.projectDirectory,
        skipSandboxPrewarm: authoringCase.skipSandboxPrewarm,
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
  return { timeoutSeconds };
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

async function casePrompts(authoringCase) {
  const prompts = [];
  await authoringCase.interact({
    send: async (prompt) => {
      prompts.push(prompt);
      return { text: "", toolCalls: [] };
    },
  });
  return prompts;
}

async function promptForCase(authoringCase, fixtureRoot) {
  const prompts = await casePrompts(authoringCase);
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
      (options.timeoutSeconds === undefined
        ? ""
        : `  timeoutSeconds: ${options.timeoutSeconds},\n`) +
      `  benchmark: ${JSON.stringify(options.benchmark)},\n` +
      `  treatment: ${JSON.stringify(options.treatment)},\n` +
      (options.verbose === undefined ? "" : `  verbose: ${options.verbose},\n`) +
      `});\n`,
  );
}
