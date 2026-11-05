import { loadDeclaration } from "../_shared.mjs";

export default {
  packageName: "@workflow/world-vercel",
  compiledPath: "@workflow/world-vercel",
  chunkGroup: "workflow",
  declaration: await loadDeclaration("workflow-world-vercel.d.ts"),
};
