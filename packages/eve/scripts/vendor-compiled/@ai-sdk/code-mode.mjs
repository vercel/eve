import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@ai-sdk/code-mode",
  compiledPath: "@ai-sdk/code-mode",
  bundling: "standalone",
  bundledPackages: [
    {
      packageName: "run",
      copyFiles: ["LICENSE", "THIRD_PARTY_NOTICES.md"],
      fingerprintFiles: [
        "dist/index.js",
        "dist/runtime/worker-source.js",
        "THIRD_PARTY_NOTICES.md",
      ],
    },
  ],
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      ai: { kind: "external" },
      run: {
        kind: "stub",
        stubBaseName: "_run",
        build: () => "export declare function setMaxWorkers(maxWorkers?: number): void;\n",
      },
    },
  }),
  external(source) {
    return source === "ai";
  },
};
