import { fileURLToPath } from "node:url";

import { loadDeclaration } from "./_shared.mjs";

const declaration = await loadDeclaration("shadcn-registry.d.ts");

export default {
  packageName: "shadcn",
  compiledPath: "shadcn-registry",
  entries: [
    {
      input: fileURLToPath(new URL("./entries/shadcn-registry.mjs", import.meta.url)),
      outputPath: "index",
      declaration,
    },
  ],
  bundling: "standalone",
  banner: `/* oxlint-disable */
import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
const __filename = __eveFileURLToPath(import.meta.url);
const __dirname = __eveDirname(__filename);`,
};
