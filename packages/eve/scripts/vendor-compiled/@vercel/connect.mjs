import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@vercel/connect",
  compiledPath: "@vercel/connect",
  copyDeclarations: createDeclarationCopier({
    files: ({ distEntries }) =>
      distEntries
        .filter((file) => file.endsWith(".d.ts"))
        .sort()
        .map((file) => ({ source: file, output: file })),
  }),
};
