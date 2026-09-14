import { relative } from "node:path";

import { collectFilesRecursively, createDeclarationCopier } from "../_shared.mjs";

async function discoverDeclarationFiles({ distDir }) {
  const files = await collectFilesRecursively(distDir, [".d.ts"]);
  return files
    .map((file) => relative(distDir, file).replaceAll("\\", "/"))
    .sort()
    .map((file) => ({ source: file, output: file }));
}

/** Vendored server-side Vercel Blob slice used by the file-memory backend. */
export default {
  packageName: "@vercel/blob",
  compiledPath: "@vercel/blob",
  bundling: "standalone",
  copyDeclarations: createDeclarationCopier({
    files: discoverDeclarationFiles,
    rewrites: {
      "node:http": { kind: "external" },
      stream: { kind: "external" },
      undici: { kind: "external" },
    },
  }),
  entry: "dist/index.js",
};
