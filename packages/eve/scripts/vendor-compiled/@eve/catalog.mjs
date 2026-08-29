import { loadDeclaration } from "../_shared.mjs";

/** Bundle the private workspace catalog so the published eve package stays self-contained. */
export default {
  packageName: "@eve/catalog",
  compiledPath: "@eve/catalog",
  bundling: "standalone",
  declaration: await loadDeclaration("@eve/catalog.d.ts"),
  fingerprintFiles: ["package.json", "src/index.ts"],
};
