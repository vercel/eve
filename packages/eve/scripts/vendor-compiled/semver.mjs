import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "semver",
  compiledPath: "semver",
  bundling: "standalone",
  declaration: await loadDeclaration("semver.d.ts"),
};
