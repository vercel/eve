import { loadDeclaration } from "../_shared.mjs";

export default {
  packageName: "@ai-sdk/mcp",
  compiledPath: "@ai-sdk/mcp",
  chunkGroup: "workflow",
  declaration: await loadDeclaration("@ai-sdk/mcp.d.ts"),
};
