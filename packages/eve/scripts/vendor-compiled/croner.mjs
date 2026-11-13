import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "croner",
  compiledPath: "croner",
  bundling: "standalone",
  declaration: await loadDeclaration("croner.d.ts"),
};
