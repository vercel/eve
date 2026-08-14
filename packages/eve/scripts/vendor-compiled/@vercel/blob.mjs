import { loadDeclaration } from "../_shared.mjs";

/** Vendored server-side Vercel Blob slice used by the file-memory backend. */
export default {
  packageName: "@vercel/blob",
  compiledPath: "@vercel/blob",
  bundling: "standalone",
  entries: [
    {
      entry: "dist/index.js",
      outputPath: "index",
      declaration: await loadDeclaration("@vercel/blob.d.ts"),
    },
  ],
};
