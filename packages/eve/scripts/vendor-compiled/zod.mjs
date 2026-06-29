import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "zod",
  compiledPath: "zod",
  chunkGroup: "client",
  declaration: await loadDeclaration("zod.d.ts"),
  platform: "neutral",
};
