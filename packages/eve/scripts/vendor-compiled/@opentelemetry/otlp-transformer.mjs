import { loadDeclaration } from "../_shared.mjs";

export default {
  packageName: "@opentelemetry/otlp-transformer",
  compiledPath: "@opentelemetry/otlp-transformer",
  chunkGroup: "workflow",
  declaration: await loadDeclaration("@opentelemetry/otlp-transformer.d.ts"),
};
