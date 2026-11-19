import { createDeclarationCopier } from "./_shared.mjs";

export default {
  packageName: "just-secrets",
  compiledPath: "just-secrets",
  bundling: "standalone",
  fingerprintFiles: ["src/windows.ps1"],
  copyDeclarations: createDeclarationCopier({
    declarationRoot: "src",
    discoverExtraFiles: () => ["windows.ps1"],
  }),
};
