import { fileURLToPath } from "node:url";

import { loadDeclaration } from "../_shared.mjs";

/**
 * Vendor config for `@vercel/detect-agent`. Upstream ships only
 * `dist/index.js` as CommonJS, so an ESM wrapper at
 * `entries/@vercel/detect-agent.mjs` re-exports the one name eve imports
 * (`determineAgent`). Bundling through that wrapper preserves the
 * named-export shape rolldown loses when it normalizes a raw CJS module
 * to ESM.
 */
const wrapperEntry = fileURLToPath(
  new URL("./entries/@vercel/detect-agent.mjs", new URL("../", import.meta.url)),
);

export default {
  packageName: "@vercel/detect-agent",
  compiledPath: "@vercel/detect-agent",
  bundling: "standalone",
  entries: [
    {
      input: wrapperEntry,
      outputPath: "index",
      declaration: await loadDeclaration("@vercel/detect-agent.d.ts"),
    },
  ],
};
