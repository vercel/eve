import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

let rolldownPromise;
let rolldownParseAstPromise;

const require = createRequire(import.meta.url);

export function resolveRolldownVersion() {
  const packageJson = require("rolldown/package.json");
  if (typeof packageJson.version !== "string") {
    throw new Error("eve's Rolldown package does not declare a version.");
  }
  return packageJson.version;
}

export async function loadRolldown() {
  rolldownPromise ??= import(pathToFileURL(require.resolve("rolldown")).href);
  return await rolldownPromise;
}

export async function loadRolldownParseAst() {
  rolldownParseAstPromise ??= import(pathToFileURL(require.resolve("rolldown/parseAst")).href);
  return await rolldownParseAstPromise;
}

export async function buildWithRolldown(options) {
  assertCustomRolldownConditionNames(options);
  const { build } = await loadRolldown();
  return await build(options);
}

const ROLLDOWN_STANDARD_CONDITION_NAMES = new Set([
  "browser",
  "default",
  "import",
  "node",
  "require",
]);

function assertCustomRolldownConditionNames(options) {
  for (const conditionName of options.resolve?.conditionNames ?? []) {
    if (ROLLDOWN_STANDARD_CONDITION_NAMES.has(conditionName)) {
      throw new Error(
        `Rolldown resolves the standard condition ${JSON.stringify(conditionName)} per import edge; conditionNames may contain only eve-specific additions.`,
      );
    }
  }
}
