import { loadDeclaration } from "../_shared.mjs";

export default {
  packageName: "@ai-sdk/harness",
  compiledPath: "@ai-sdk/harness",
  chunkGroup: "harness",
  external(source) {
    return source === "ai" || source.startsWith("ai/");
  },
  entries: [
    {
      entry: "dist/index.js",
      outputPath: "index",
      declaration: await loadDeclaration("ai-sdk-harness.d.ts"),
    },
    {
      entry: "dist/agent/index.js",
      outputPath: "agent/index",
      declaration: await loadDeclaration("ai-sdk-harness-agent.d.ts"),
    },
    {
      entry: "dist/utils/index.js",
      outputPath: "utils/index",
      declaration: await loadDeclaration("ai-sdk-harness-utils.d.ts"),
    },
  ],
};
