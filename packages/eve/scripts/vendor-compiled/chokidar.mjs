import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "chokidar",
  compiledPath: "chokidar",
  bundling: "standalone",
  declaration: await loadDeclaration("chokidar.d.ts"),
};
