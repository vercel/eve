import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const DECLARATIONS = [
  ["acp.d.ts", "index.d.ts"],
  ["jsonrpc.d.ts", "jsonrpc.d.ts"],
  ["stream.d.ts", "stream.d.ts"],
  ["schema/guards.gen.d.ts", "schema/guards.gen.d.ts"],
  ["schema/index.d.ts", "schema/index.d.ts"],
  ["schema/types.gen.d.ts", "schema/types.gen.d.ts"],
];

/** Vendor the stable ACP v1 SDK without adding it to eve's runtime dependencies. */
export default {
  packageName: "@agentclientprotocol/sdk",
  compiledPath: "@agentclientprotocol/sdk",
  bundling: "standalone",
  copyDeclarations: async ({ destinationRoot, packageInfo }) => {
    const sourceRoot = join(packageInfo.packageRoot, "dist");
    for (const [sourceFile, destinationFile] of DECLARATIONS) {
      const destinationPath = join(destinationRoot, destinationFile);
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, await readFile(join(sourceRoot, sourceFile)), "utf8");
    }
  },
};
