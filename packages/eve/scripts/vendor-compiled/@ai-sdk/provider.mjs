import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@ai-sdk/provider",
  compiledPath: "@ai-sdk/provider",
  chunkGroup: "workflow",
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      "json-schema": {
        kind: "vendored",
        compiledPath: "json-schema",
      },
    },
  }),
};
