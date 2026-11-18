import { fileURLToPath } from "node:url";

import { loadDeclaration } from "../_shared.mjs";

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
