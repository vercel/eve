import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "turndown",
  compiledPath: "turndown",
  bundling: "standalone",
  declaration: await loadDeclaration("turndown.d.ts"),
};
