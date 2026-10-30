import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@vercel/schedules",
  compiledPath: "@vercel/schedules",
  bundling: "standalone",
  copyDeclarations: createDeclarationCopier({
    files: ({ distEntries }) =>
      distEntries
        .filter((file) => file.endsWith(".d.ts"))
        .sort()
        .map((file) => ({ source: file, output: file })),
  }),
};
