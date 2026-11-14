/**
 * Resolves eve's own `#compiled/*` and `#*.js` subpath imports, and relative
 * imports between eve's dist modules, without Node's package-scope lookups.
 * Importing this module installs the hook for the current thread. It does
 * nothing when loaded from TypeScript source.
 *
 * Node parses the whole `exports` map of the nearest package.json again on
 * every subpath-import resolution. eve's map is large and eve resolves
 * thousands of `#` imports at startup, so every eve process and worker spent
 * a measurable part of its boot parsing the same JSON. Node repeats the lookup
 * to detect each loaded file's module format, which the hook reports instead.
 *
 * The mapping matches `imports` in eve's package.json under Node's default
 * conditions, which package-imports-hook.test.ts enforces. Other condition
 * sets (`eve-source`) and unusual specifiers fall through to Node.
 *
 * This module must not import eve modules: they load after the hook exists.
 */
import { statSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";

const distSourceUrl = new URL("../", import.meta.url).href;
const COMPILED_PREFIX = "#compiled/";
const INSTALLED = Symbol.for("eve.packageImportsHook");

/** Maps one import made by an eve module under `root`, or returns undefined for Node to resolve. */
export function resolveEveDistImport(
  specifier: string,
  parentUrl: string | undefined,
  conditions: readonly string[] | undefined,
  root: string = distSourceUrl,
): string | undefined {
  if (parentUrl?.startsWith(root) !== true) return undefined;
  // eve's relative imports stay inside dist/src, where every `.js` file is ESM.
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    if (!specifier.endsWith(".js") || /[\\%?#]/u.test(specifier)) return undefined;
    const url = new URL(specifier, parentUrl).href;
    return url.startsWith(root) ? url : undefined;
  }
  if (specifier[0] !== "#" || conditions?.includes("eve-source") === true) return undefined;
  // Node validates these and reports its own errors.
  if (/[\\%*]|\/\/|(?:^|\/)(?:\.{1,2}|node_modules)(?:\/|$)/u.test(specifier.slice(1))) {
    return undefined;
  }
  // Node picks the pattern with the longest prefix, so `#compiled/*` wins over `#*.js`.
  if (specifier.startsWith(COMPILED_PREFIX)) {
    return new URL(`compiled/${specifier.slice(COMPILED_PREFIX.length)}`, root).href;
  }
  if (specifier.endsWith(".js") && specifier[1] !== "/") {
    return new URL(specifier.slice(1), root).href;
  }
  return undefined;
}

const state = globalThis as { [INSTALLED]?: true };
// `registerHooks` is missing from Bun; it keeps the runtime's own resolution.
if (
  !import.meta.url.endsWith(".ts") &&
  typeof nodeModule.registerHooks === "function" &&
  state[INSTALLED] !== true
) {
  state[INSTALLED] = true;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = resolveEveDistImport(specifier, context.parentURL, context.conditions);
      // Node reports missing files and directories with its own error codes.
      if (
        url === undefined ||
        statSync(fileURLToPath(url), { throwIfNoEntry: false })?.isFile() !== true
      ) {
        return nextResolve(specifier, context);
      }
      // A format skips Node's per-module package.json lookup to detect one.
      return url.endsWith(".js")
        ? { format: "module", shortCircuit: true, url }
        : { shortCircuit: true, url };
    },
  });
}
