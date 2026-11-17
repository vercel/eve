import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export default {
  packageName: "commander",
  compiledPath: "commander",
  bundling: "standalone",
  copyDeclarations: async ({ destinationRoot, packageInfo }) => {
    const sourcePath = join(packageInfo.packageRoot, "typings", "index.d.ts");
    const source = await readFile(sourcePath, "utf8");
    await writeFile(join(destinationRoot, "index.d.ts"), source, "utf8");
  },
};
