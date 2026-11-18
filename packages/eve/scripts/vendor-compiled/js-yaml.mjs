import { fileURLToPath } from "node:url";

import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "js-yaml",
  compiledPath: "js-yaml",
  entries: [
    {
      input: fileURLToPath(new URL("./entries/js-yaml.mjs", import.meta.url)),
      outputPath: "index",
      declaration: await loadDeclaration("js-yaml.d.ts"),
    },
  ],
  bundling: "standalone",
};
