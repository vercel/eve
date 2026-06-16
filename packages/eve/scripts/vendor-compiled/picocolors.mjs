import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "picocolors",
  compiledPath: "picocolors",
  bundling: "standalone",
  declaration: await loadDeclaration("picocolors.d.ts"),
};
