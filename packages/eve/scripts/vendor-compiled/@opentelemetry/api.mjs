import { loadDeclaration } from "../_shared.mjs";

export default {
  packageName: "@opentelemetry/api",
  compiledPath: "@opentelemetry/api",
  chunkGroup: "workflow",
  entry: "build/esm/index.js",
  declaration: await loadDeclaration("@opentelemetry/api.d.ts"),
};
