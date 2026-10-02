import { loadDeclaration } from "../_shared.mjs";

/**
 * JSON Schema validator for tool schemas that arrive as plain JSON Schema
 * (MCP, OpenAPI, serialized output schemas, and eve's own framework tools).
 * It interprets schemas without code generation, so it runs anywhere eve does.
 */
export default {
  packageName: "@cfworker/json-schema",
  compiledPath: "@cfworker/json-schema",
  bundling: "standalone",
  platform: "neutral",
  declaration: await loadDeclaration("@cfworker/json-schema.d.ts"),
};
