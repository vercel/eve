import { createDeclarationCopier } from "../_shared.mjs";

/**
 * Stub for `json-schema`. Upstream `@ai-sdk/provider` references
 * `JSONSchema7` / `JSONSchema7Definition` from `@types/json-schema`.
 * Consumers shouldn't have to install `@types/json-schema` just to
 * typecheck against eve, so the names are aliased to opaque structural
 * placeholders. Anyone needing the real JSONSchema7 types can install
 * `@types/json-schema` and refine downstream.
 */
function buildJsonSchemaStub(names, moduleName) {
  const declarations = {
    JSONSchema7: `export type JSONSchema7 = Record<string, unknown>;`,
    JSONSchema7Definition: `export type JSONSchema7Definition = JSONSchema7 | boolean;`,
  };

  const lines = [
    `// Auto-generated stub for \`${moduleName}\` types referenced by a vendored .d.ts.`,
    `// Emitted by scripts/vendor-compiled/@ai-sdk/provider.mjs.`,
    ``,
  ];
  for (const name of [...names].sort()) {
    if (Object.prototype.hasOwnProperty.call(declarations, name)) {
      lines.push(declarations[name]);
    } else {
      lines.push(`export type ${name} = unknown;`);
    }
  }
  return `${lines.join("\n")}\n`;
}

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
        kind: "stub",
        stubBaseName: "_json-schema",
        build: buildJsonSchemaStub,
      },
    },
  }),
};
