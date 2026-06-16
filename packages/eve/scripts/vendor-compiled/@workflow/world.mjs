import { relative } from "node:path";

import { collectFilesRecursively, createDeclarationCopier } from "../_shared.mjs";

async function discoverDeclarationFiles({ distDir }) {
  const files = await collectFilesRecursively(distDir, [".d.ts"]);
  return files
    .map((file) => relative(distDir, file).replaceAll("\\", "/"))
    .sort()
    .map((file) => ({ source: file, output: file }));
}

/**
 * Type-only vendored copy of `@workflow/world`. `@workflow/core`'s runtime
 * JS bundles world directly, so nothing imports this module's `index.js` at
 * runtime — it exists purely so core's vendored `.d.ts` files can resolve
 * `World`, `WorkflowRun`, `Event`, `Hook`, and friends against the real
 * upstream declarations instead of a hand-written stub that drifts on every
 * bump.
 *
 * The declaration tree only reaches `zod` (and the `zod/v4` subpath, which is
 * the same v4 surface in zod >= 4); both rewrite to eve's vendored zod. These
 * resolve correctly even though `@workflow/core` reaches world's types through
 * `getWorld()` because vendored directories carry no `package.json` to shadow
 * eve's `#compiled/*` imports map (see `prepareCompiledModule` in _shared.mjs).
 */
export default {
  packageName: "@workflow/world",
  compiledPath: "@workflow/world",
  typeOnly: true,
  copyDeclarations: createDeclarationCopier({
    files: discoverDeclarationFiles,
    rewrites: {
      zod: { kind: "vendored", compiledPath: "zod" },
      "zod/v4": { kind: "vendored", compiledPath: "zod" },
    },
  }),
};
