import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@vercel/queue",
  compiledPath: "@vercel/queue",
  bundling: "standalone",
  entry: "dist/index.mjs",
  copyDeclarations: createDeclarationCopier({
    files: ({ distEntries }) =>
      distEntries
        .filter((file) => file.endsWith(".d.ts"))
        .sort()
        .map((file) => ({ source: file, output: file })),
  }),
};
