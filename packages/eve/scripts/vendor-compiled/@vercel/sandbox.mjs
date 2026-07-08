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

/**
 * Copy the complete declaration tree from the installed SDK so every Vercel
 * Sandbox version bump updates eve's public option types automatically.
 * Bare type dependencies are redirected to existing vendored declarations
 * or local stubs, while Node built-ins remain external.
 */
export default {
  packageName: "@vercel/sandbox",
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
