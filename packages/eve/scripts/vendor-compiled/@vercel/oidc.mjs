import { fileURLToPath } from "node:url";

import { loadDeclaration } from "../_shared.mjs";

/**
 * Vendor config for `@vercel/oidc`. eve uses only `getVercelOidcToken`,
 * so the declaration narrows the upstream surface to that single function
 * (the multi-file `dist/` declaration tree is intentionally not copied).
 *
 * Upstream ships only `dist/index.js` as CommonJS, so an ESM wrapper at
 * `entries/@vercel/oidc.mjs` re-exports the names eve imports. Bundling
 * through that wrapper preserves the named-export shape rolldown loses
 * when it normalizes a raw CJS module to ESM.
 */
const wrapperEntry = fileURLToPath(
  new URL("./entries/@vercel/oidc.mjs", new URL("../", import.meta.url)),
);

export default {
  packageName: "@vercel/oidc",
  compiledPath: "@vercel/oidc",
  bundling: "standalone",
  entries: [
    {
      input: wrapperEntry,
      outputPath: "index",
      declaration: await loadDeclaration("@vercel/oidc.d.ts"),
    },
  ],
};
