import { fileURLToPath } from "node:url";

import { loadDeclaration } from "../_shared.mjs";

/**
 * Vendor config for the slice of `@vercel/sdk` the dev TUI uses: the
 * trusted-sources model helpers re-exported by `entries/@vercel/sdk.mjs`.
 * The SDK's models import `zod/v3`, which resolves to eve's vendored Zod.
 */
const wrapperEntry = fileURLToPath(
  new URL("./entries/@vercel/sdk.mjs", new URL("../", import.meta.url)),
);

export default {
  packageName: "@vercel/sdk",
  compiledPath: "@vercel/sdk",
  bundling: "standalone",
  entries: [
    {
      input: wrapperEntry,
      outputPath: "index",
      declaration: await loadDeclaration("@vercel/sdk.d.ts"),
    },
  ],
};
