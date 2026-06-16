import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Vendor config for `commander`. The package ships:
 *
 *   - `index.js`            CJS entry (`module.exports = { Command, ... }`)
 *   - `esm.mjs`             ESM wrapper that re-exports named bindings.
 *   - `typings/index.d.ts`  Single-file declaration with no external imports.
 *
 * The default rolldown resolution picks `esm.mjs` because the per-package
 * config inherits `conditionNames: ["node", "import", "default"]`. That
 * collapses the CJS `index.js` graph through the wrapper and produces an
 * ESM bundle whose named exports match the source-side usage
 * (`Command`, `CommanderError`, `InvalidArgumentError`).
 *
 * Declarations are copied verbatim from `typings/index.d.ts` so the type
 * surface tracks upstream on every bump. `createDeclarationCopier` cannot
 * be reused here because it hard-codes the upstream `dist/` directory and
 * commander emits its `.d.ts` under `typings/` instead.
 */
export default {
  packageName: "commander",
  compiledPath: "commander",
  bundling: "standalone",
  copyDeclarations: async ({ destinationRoot, packageInfo }) => {
    const sourcePath = join(packageInfo.packageRoot, "typings", "index.d.ts");
    const source = await readFile(sourcePath, "utf8");
    await writeFile(join(destinationRoot, "index.d.ts"), source, "utf8");
  },
};
