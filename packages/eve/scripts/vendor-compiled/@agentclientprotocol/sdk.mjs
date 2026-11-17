import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createDeclarationCopier } from "../_shared.mjs";

const copyRootDeclarations = createDeclarationCopier({
  files: [{ source: "v1/stable/acp.d.ts", output: "v1/stable/acp.d.ts" }],
});

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
