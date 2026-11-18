import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@standard-schema/spec",
  compiledPath: "@standard-schema/spec",
  typeOnly: true,
  copyDeclarations: createDeclarationCopier(),
};
