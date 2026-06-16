import { buildOpaqueTypesStub, createDeclarationCopier } from "../_shared.mjs";

/**
 * Type declarations are copied verbatim from the installed
 * @ai-sdk/openai version. The previous hand-written stub declared only
 * `openai.tools.webSearch()`, hiding the full OpenAIProvider /
 * OpenAIResponsesLanguageModel / OpenAIChatLanguageModel surface
 * upstream actually exports. Copying upstream keeps eve's vendored
 * types in sync without hand-editing on every AI SDK bump.
 *
 * Rewrites:
 *
 * - `@ai-sdk/provider` → already vendored, re-route both the named and
 *   the `import * as _ai_sdk_provider` namespace import at the vendored
 *   copy.
 * - `@ai-sdk/provider-utils` → local opaque-type stub; eve doesn't
 *   surface provider-utils' types to user code. `resolveWebSearchProviderTool`
 *   casts the returned tool to `ToolSet[string]`.
 */
export default {
  packageName: "@ai-sdk/openai",
  compiledPath: "@ai-sdk/openai",
  chunkGroup: "workflow",
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      "@ai-sdk/provider": { kind: "vendored", compiledPath: "@ai-sdk/provider" },
      "@ai-sdk/provider-utils": {
        kind: "stub",
        stubBaseName: "_provider-utils",
        build: buildOpaqueTypesStub,
      },
    },
  }),
};
