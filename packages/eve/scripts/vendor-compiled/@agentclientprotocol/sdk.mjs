import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// The declaration closure of the package root (`dist/v1/stable/acp.d.ts`),
// copied with its layout so relative imports keep resolving.
const DECLARATIONS = [
  "core/app-handlers.d.ts",
  "core/connection-access.d.ts",
  "core/jsonrpc.d.ts",
  "core/stream-limits.d.ts",
  "core/stream.d.ts",
  "transports/connection.d.ts",
  "v1/schema/guards.gen.d.ts",
  "v1/schema/index.d.ts",
  "v1/schema/types.gen.d.ts",
  "v1/stable/acp.d.ts",
];

/** Vendor the stable ACP v1 SDK without adding it to eve's runtime dependencies. */
export default {
  packageName: "@agentclientprotocol/sdk",
  compiledPath: "@agentclientprotocol/sdk",
  bundling: "standalone",
  copyDeclarations: async ({ destinationRoot, packageInfo }) => {
    const sourceRoot = join(packageInfo.packageRoot, "dist");
    for (const file of DECLARATIONS) {
      const destinationPath = join(destinationRoot, file);
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, await readFile(join(sourceRoot, file)), "utf8");
    }
    await writeFile(
      join(destinationRoot, "index.d.ts"),
      'export * from "./v1/stable/acp.js";\n',
      "utf8",
    );
  },
};
