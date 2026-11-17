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
