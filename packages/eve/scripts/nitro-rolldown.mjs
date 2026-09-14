import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

let rolldownPromise;
let rolldownParseAstPromise;

function createNitroRequire() {
  const require = createRequire(import.meta.url);
  return createRequire(require.resolve("nitro/package.json"));
}

export function resolveNitroRolldownVersion() {
  const packageJson = createNitroRequire()("rolldown/package.json");
  if (typeof packageJson.version !== "string") {
    throw new Error("Nitro's Rolldown package does not declare a version.");
  }
  return packageJson.version;
}

export async function loadNitroRolldown() {
  rolldownPromise ??= (async () => {
    const nitroRequire = createNitroRequire();
    return await import(pathToFileURL(nitroRequire.resolve("rolldown")).href);
  })();

  return await rolldownPromise;
}

export async function loadNitroRolldownParseAst() {
  rolldownParseAstPromise ??= (async () => {
    const nitroRequire = createNitroRequire();
    return await import(pathToFileURL(nitroRequire.resolve("rolldown/parseAst")).href);
  })();

  return await rolldownParseAstPromise;
}

export async function buildWithNitroRolldown(options) {
  assertCustomRolldownConditionNames(options);
  const { build } = await loadNitroRolldown();
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
