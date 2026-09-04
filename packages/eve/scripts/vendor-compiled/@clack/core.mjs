import { createDeclarationCopier } from "../_shared.mjs";

/** Bundle the prompt primitives used by eve's unbundled setup modules. */
export default {
  packageName: "@clack/core",
  compiledPath: "@clack/core",
  bundling: "standalone",
  copyDeclarations: createDeclarationCopier({
    files: [{ source: "index.d.mts", output: "index.d.ts" }],
    rewrites: {},
  }),
};
