import { relative, sep } from "node:path";

import { collectFilesRecursively, createDeclarationCopier } from "../_shared.mjs";

function toPosixPath(path) {
  return path.split(sep).join("/");
}

function buildRunStub(names, moduleName) {
  const unsupported = [...names].filter((name) => name !== "setMaxWorkers");
  if (unsupported.length > 0) {
    throw new Error(
      `Vendor: unsupported ${moduleName} declaration imports: ${unsupported.join(", ")}`,
    );
  }
  return "export declare function setMaxWorkers(maxWorkers?: number): void;\n";
}

export default {
  packageName: "@ai-sdk/code-mode",
  compiledPath: "@ai-sdk/code-mode",
  bundling: "standalone",
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      ai: { kind: "external" },
      run: { kind: "stub", stubBaseName: "_run", build: buildRunStub },
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
