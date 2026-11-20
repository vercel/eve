import { statSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";

import { resolveEveDistImport } from "./package-imports.js";

const INSTALLED = Symbol.for("eve.packageImportsHook");

const state = globalThis as { [INSTALLED]?: true };
if (
  !import.meta.url.endsWith(".ts") &&
  typeof nodeModule.registerHooks === "function" &&
  state[INSTALLED] !== true
) {
  state[INSTALLED] = true;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = resolveEveDistImport(specifier, context.parentURL, context.conditions);
      if (
        url === undefined ||
        statSync(fileURLToPath(url), { throwIfNoEntry: false })?.isFile() !== true
      ) {
        return nextResolve(specifier, context);
      }
      return url.endsWith(".js")
        ? { format: "module", shortCircuit: true, url }
        : { shortCircuit: true, url };
    },
  });
}
