import { createDeclarationCopier } from "./_shared.mjs";

export default {
  packageName: "run",
  compiledPath: "run",
  bundling: "standalone",
  copyDeclarations: createDeclarationCopier(),
};
