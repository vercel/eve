import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "jose",
  compiledPath: "jose",
  chunkGroup: "workflow",
  declaration: await loadDeclaration("jose.d.ts"),
};
