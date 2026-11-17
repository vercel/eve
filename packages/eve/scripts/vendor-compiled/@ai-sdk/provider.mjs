import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@ai-sdk/provider",
  compiledPath: "@ai-sdk/provider",
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      "json-schema": {
        kind: "vendored",
        compiledPath: "json-schema",
      },
    },
  }),
};
