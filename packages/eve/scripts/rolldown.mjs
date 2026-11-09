import { createRequire } from "node:module";

// eve declares `rolldown` itself and hands the same copy to Nitro through
// `deps.paths`. It loads lazily so commands that never bundle skip the
// native binding.

let rolldownPromise;
let rolldownParseAstPromise;

export function resolveRolldownVersion() {
  const packageJson = createRequire(import.meta.url)("rolldown/package.json");
  if (typeof packageJson.version !== "string") {
    throw new Error("eve's Rolldown package does not declare a version.");
  }
  return packageJson.version;
}

export async function loadRolldown() {
  rolldownPromise ??= import("rolldown");
  return await rolldownPromise;
}

export async function loadRolldownParseAst() {
  rolldownParseAstPromise ??= import("rolldown/parseAst");
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
