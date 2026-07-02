import { createDeclarationCopier } from "../_shared.mjs";

/**
 * Type declarations are copied verbatim from the installed
 * @ai-sdk/anthropic version. The previous hand-written stub declared
 * only `anthropic.tools.webSearch_20250305()`, hiding the full
 * AnthropicProvider/AnthropicMessageMetadata/AnthropicProviderOptions
 * surface upstream actually exports. Copying upstream keeps eve's
 * vendored types in sync without hand-editing on every AI SDK bump.
 *
 * Rewrites:
 *
 * - `@ai-sdk/provider` → already vendored, re-route to the vendored
 *   `#compiled/@ai-sdk/provider/index.js`.
 * - `zod/v4` → eve's vendored `zod` (which re-exports from the real
 *   installed `zod` package).
 * - `@ai-sdk/provider-utils` → type-only vendored upstream declarations.
 */
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
