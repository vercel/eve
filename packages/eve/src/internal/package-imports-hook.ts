/**
 * Resolves eve's own `#compiled/*` and `#*.js` subpath imports, and relative
 * imports between eve's dist modules, without Node's package-scope lookups.
 * Importing this module installs the hook for the current thread. It does
 * nothing when loaded from TypeScript source. The mapping lives in
 * package-imports.ts.
 *
 * Node parses the whole `exports` map of the nearest package.json again on
 * every subpath-import resolution. eve's map is large and eve resolves
 * thousands of `#` imports at startup, so every eve process and worker spent
 * a measurable part of its boot parsing the same JSON. Node repeats the lookup
 * to detect each loaded file's module format, which the hook reports instead.
 *
 * This module must not import eve modules through `#` imports or packages:
 * they load after the hook exists.
 */
import { statSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";

import { resolveEveDistImport } from "./package-imports.js";

const INSTALLED = Symbol.for("eve.packageImportsHook");

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
