import { fileURLToPath } from "node:url";

import { loadDeclaration } from "./_shared.mjs";

const declaration = await loadDeclaration("zod.d.ts");

export default {
  packageName: "zod",
  compiledPath: "zod",
  chunkGroup: "client",
  entries: [
    {
      declaration,
      input: fileURLToPath(new URL("./entries/zod.mjs", import.meta.url)),
      outputPath: "index",
    },
  ],
  platform: "neutral",
};
