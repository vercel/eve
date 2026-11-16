import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Vendor config for `commander`. The package ships:
 *
 *   - `index.js`            ESM entry with named exports.
 *   - `typings/index.d.ts`  Single-file declaration with no external imports.
 *
 * Rolldown bundles the `index.js` graph and keeps the named exports matching
 * the source-side usage (`Command`, `CommanderError`,
 * `InvalidArgumentError`).
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
