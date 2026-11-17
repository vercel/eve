import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@ai-sdk/google",
  compiledPath: "@ai-sdk/google",
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      "@ai-sdk/provider": { kind: "vendored", compiledPath: "@ai-sdk/provider" },
      "@ai-sdk/provider-utils": {
        kind: "vendored",
        compiledPath: "@ai-sdk/provider-utils",
      },
      "zod/v4": { kind: "vendored", compiledPath: "zod" },
    },
  }),
};
