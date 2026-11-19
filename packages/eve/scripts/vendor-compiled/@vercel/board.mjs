import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@vercel/board",
  compiledPath: "@vercel/board",
  copyDeclarations: createDeclarationCopier({
    files: [{ source: "index.node.d.mts", output: "index.d.ts" }],
    rewrites: {
      jose: { kind: "vendored", compiledPath: "jose" },
      zod: { kind: "vendored", compiledPath: "zod" },
    },
  }),
};
