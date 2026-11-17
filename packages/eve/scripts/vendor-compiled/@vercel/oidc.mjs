import { fileURLToPath } from "node:url";

import { loadDeclaration } from "../_shared.mjs";

const wrapperEntry = fileURLToPath(
  new URL("./entries/@vercel/oidc.mjs", new URL("../", import.meta.url)),
);

export default {
  packageName: "@vercel/oidc",
  compiledPath: "@vercel/oidc",
  entries: [
    {
      input: wrapperEntry,
      outputPath: "index",
      declaration: await loadDeclaration("@vercel/oidc.d.ts"),
    },
  ],
};
