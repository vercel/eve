import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "jsonc-parser",
  compiledPath: "jsonc-parser",
  bundling: "standalone",
  declaration: await loadDeclaration("jsonc-parser.d.ts"),
};
