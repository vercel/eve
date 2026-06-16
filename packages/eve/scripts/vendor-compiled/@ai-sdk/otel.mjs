import { loadDeclaration } from "../_shared.mjs";

/**
 * `ai` is a peer dep of eve (consumers install it), so it must never be
 * bundled into vendored chunks. Mark every `ai`-rooted import external so
 * the bundler leaves them as runtime imports the consumer's installation
 * resolves.
 */
function isAiImport(source) {
  return source === "ai" || source.startsWith("ai/");
}

export default {
  packageName: "@ai-sdk/otel",
  compiledPath: "@ai-sdk/otel",
  chunkGroup: "workflow",
  external: isAiImport,
  declaration: await loadDeclaration("@ai-sdk/otel.d.ts"),
};
