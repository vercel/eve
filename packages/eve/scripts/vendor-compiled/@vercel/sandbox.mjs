import { relative } from "node:path";

import {
  buildOpaqueTypesStub,
  buildUniqueSymbolStub,
  collectFilesRecursively,
  createDeclarationCopier,
  createOptionalNativeStubPlugin,
} from "../_shared.mjs";

async function discoverDeclarationFiles({ distDir }) {
  const files = await collectFilesRecursively(distDir, [".d.ts"]);
  return files
    .map((file) => relative(distDir, file).replaceAll("\\", "/"))
    .sort()
    .map((file) => ({ source: file, output: file }));
}

/** Copy the complete stable Sandbox declaration tree for public types and runtime loading. */
export default {
  packageName: "@vercel/sandbox",
  packageJsonName: "@vercel/sandbox",
  compiledPath: "@vercel/sandbox",
  plugins: [createOptionalNativeStubPlugin(["fsevents"])],
  copyDeclarations: createDeclarationCopier({
    files: discoverDeclarationFiles,
    rewrites: {
      "@workflow/serde": {
        kind: "stub",
        stubBaseName: "_workflow-serde",
        build: buildUniqueSymbolStub,
      },
      "async-retry": {
        kind: "stub",
        stubBaseName: "_async-retry",
        build: buildOpaqueTypesStub,
      },
      fs: { kind: "external" },
      stream: { kind: "external" },
      zod: { kind: "vendored", compiledPath: "zod" },
    },
  }),
};
