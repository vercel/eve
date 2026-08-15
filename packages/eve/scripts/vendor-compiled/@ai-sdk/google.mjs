import { createDeclarationCopier } from "../_shared.mjs";

/**
 * Type declarations are copied verbatim from the installed
 * @ai-sdk/google version. The previous hand-written stub declared only
 * `google.tools.googleSearch()`, hiding the full GoogleGenerativeAIProvider
 * surface upstream actually exports. Copying upstream keeps eve's
 * vendored types in sync without hand-editing on every AI SDK bump.
 *
 * Rewrites:
 *
 * - `@ai-sdk/provider` → already vendored, re-route to the vendored
 *   `#compiled/@ai-sdk/provider/index.js`.
 * - `@ai-sdk/provider-utils` → type-only vendored upstream declarations.
 */
export default {
  packageName: "@ai-sdk/google",
  compiledPath: "@ai-sdk/google",
  chunkGroup: "workflow",
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      "@ai-sdk/provider": { kind: "vendored", compiledPath: "@ai-sdk/provider" },
      "@ai-sdk/provider-utils": {
        kind: "vendored",
        compiledPath: "@ai-sdk/provider-utils",
      },
    },
  }),
};
