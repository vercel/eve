import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "marked",
  compiledPath: "marked",
  bundling: "standalone",
  declaration: await loadDeclaration("marked.d.ts"),
};
