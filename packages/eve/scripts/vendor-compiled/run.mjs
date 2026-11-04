import { createDeclarationCopier } from "./_shared.mjs";

// run embeds its QuickJS WebAssembly and worker source as strings, so the bundle
// needs no assets. Standalone keeps that payload out of eve's shared chunks.
export default {
  packageName: "run",
  compiledPath: "run",
  bundling: "standalone",
  copyDeclarations: createDeclarationCopier(),
};
