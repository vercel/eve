import { createDeclarationCopier } from "./_shared.mjs";

export default {
  packageName: "@types/json-schema",
  compiledPath: "json-schema",
  typeOnly: true,
  copyDeclarations: createDeclarationCopier({
    declarationRoot: ".",
    files: [{ source: "index.d.ts", output: "index.d.ts" }],
  }),
};
