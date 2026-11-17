import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@ai-sdk/anthropic",
  compiledPath: "@ai-sdk/anthropic",
  chunkGroup: "workflow",
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      "@ai-sdk/provider": { kind: "vendored", compiledPath: "@ai-sdk/provider" },
      "zod/v4": { kind: "vendored", compiledPath: "zod" },
      "@ai-sdk/provider-utils": {
        kind: "vendored",
        compiledPath: "@ai-sdk/provider-utils",
      },
    },
  }),
};
