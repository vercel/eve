import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "zod",
  compiledPath: "zod",
  chunkGroup: "workflow",
  declaration: await loadDeclaration("zod.d.ts"),
};
