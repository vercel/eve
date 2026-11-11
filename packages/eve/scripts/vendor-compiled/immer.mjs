import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "immer",
  compiledPath: "immer",
  bundling: "standalone",
  declaration: await loadDeclaration("immer.d.ts"),
};
