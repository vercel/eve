import { fileURLToPath } from "node:url";

import { loadDeclaration } from "../_shared.mjs";

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
