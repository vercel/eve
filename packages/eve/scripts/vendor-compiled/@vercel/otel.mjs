import { loadDeclaration } from "../_shared.mjs";

export default {
  packageName: "@vercel/otel",
  compiledPath: "@vercel/otel",
  chunkGroup: "workflow",
  entry: "dist/node/index.js",
  declaration: await loadDeclaration("@vercel/otel.d.ts"),
};
