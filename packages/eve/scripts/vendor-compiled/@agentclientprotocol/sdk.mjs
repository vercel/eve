import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createDeclarationCopier } from "../_shared.mjs";

// Copies the package root's declaration and every file it imports, keeping the
// layout so relative imports resolve. The copier fails on a missing import.
const copyRootDeclarations = createDeclarationCopier({
  files: [{ source: "v1/stable/acp.d.ts", output: "v1/stable/acp.d.ts" }],
});

/** Vendor the stable ACP v1 SDK without adding it to eve's runtime dependencies. */
export default {
  packageName: "@agentclientprotocol/sdk",
  compiledPath: "@agentclientprotocol/sdk",
  bundling: "standalone",
  copyDeclarations: async (context) => {
    await copyRootDeclarations(context);
    await writeFile(
      join(context.destinationRoot, "index.d.ts"),
      'export * from "./v1/stable/acp.js";\n',
      "utf8",
    );
  },
};
