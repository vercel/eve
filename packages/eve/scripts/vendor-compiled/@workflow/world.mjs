import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { collectFilesRecursively, createDeclarationCopier } from "../_shared.mjs";

async function discoverDeclarationFiles({ distDir }) {
  const files = await collectFilesRecursively(distDir, [".d.ts"]);
  return files
    .map((file) => relative(distDir, file).replaceAll("\\", "/"))
    .sort()
    .map((file) => ({ source: file, output: file }));
}

/**
 * Vendor the hook schema used to validate inbox handles, the start Hook id a
 * session's claimed address is resumed by, and the full upstream
 * declarations used by core's vendored types. Share runtime chunks with core
 * so descriptor validation uses the same schema without duplicating it.
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
  chunkGroup: "workflow",
  entries: [
    {
      input: fileURLToPath(new URL("../entries/workflow-world.mjs", import.meta.url)),
      outputPath: "index",
    },
  ],
  copyDeclarations: createDeclarationCopier({
    files: discoverDeclarationFiles,
    rewrites: {
      zod: { kind: "vendored", compiledPath: "zod" },
      "zod/v4": { kind: "vendored", compiledPath: "zod" },
    },
  }),
};
