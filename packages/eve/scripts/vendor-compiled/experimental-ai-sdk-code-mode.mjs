import { relative, sep } from "node:path";

import { collectFilesRecursively, createDeclarationCopier } from "./_shared.mjs";

function toPosixPath(path) {
  return path.split(sep).join("/");
}

export default {
  packageName: "experimental-ai-sdk-code-mode",
  compiledPath: "experimental-ai-sdk-code-mode",
  bundling: "standalone",
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      ai: { kind: "external" },
    },
    files: async ({ distDir }) =>
      (await collectFilesRecursively(distDir, [".d.ts"]))
        .map((file) => toPosixPath(relative(distDir, file)))
        .sort()
        .map((file) => ({ source: file, output: file })),
  }),
  external(source) {
    return source === "ai";
  },
};
