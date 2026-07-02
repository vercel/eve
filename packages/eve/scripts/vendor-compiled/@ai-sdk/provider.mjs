import { createDeclarationCopier } from "../_shared.mjs";

/**
 * Type declarations are copied verbatim from the installed
 * @ai-sdk/provider version. The previous hand-written stub declared only
 * `getErrorMessage`, hiding the full LanguageModelV2/V3/V4, EmbeddingModel
 * hierarchy, error classes, and JSON value types upstream actually
 * exports. Copying upstream keeps eve's vendored types in sync without
 * hand-editing on every AI SDK bump.
 */
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
