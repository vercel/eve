import { createDeclarationCopier } from "../_shared.mjs";

function isAiImport(source) {
  return source === "ai" || source.startsWith("ai/");
}

export default {
  packageName: "@ai-sdk/otel",
  compiledPath: "@ai-sdk/otel",
  chunkGroup: "workflow",
  external: isAiImport,
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      ai: { kind: "external" },
      "@ai-sdk/provider": { kind: "vendored", compiledPath: "@ai-sdk/provider" },
      "@ai-sdk/provider-utils": {
        kind: "vendored",
        compiledPath: "@ai-sdk/provider-utils",
      },
      "@opentelemetry/api": { kind: "vendored", compiledPath: "@opentelemetry/api" },
    },
  }),
};
