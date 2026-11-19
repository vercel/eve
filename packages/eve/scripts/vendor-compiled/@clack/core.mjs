import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@clack/core",
  compiledPath: "@clack/core",
  bundling: "standalone",
  copyDeclarations: createDeclarationCopier({
    files: [{ source: "index.d.mts", output: "index.d.ts" }],
    rewrites: {},
  }),
};
