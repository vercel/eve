import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { createDeclarationCopier } from "../_shared.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tscPath = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const copyDeclarations = createDeclarationCopier({ declarationRoot: "dist/src" });

/** Bundle the private workspace catalog so the published eve package stays self-contained. */
export default {
  packageName: "@eve/catalog",
  compiledPath: "@eve/catalog",
  bundling: "standalone",
  fingerprintFiles: [
    "../../tsconfig.json",
    "package.json",
    "src/index.ts",
    "tsconfig.build.json",
    "tsconfig.json",
  ],
  copyDeclarations: async (context) => {
    await execFileAsync(
      process.execPath,
      [tscPath, "-p", "tsconfig.build.json", "--emitDeclarationOnly", "--declarationMap", "false"],
      { cwd: context.packageInfo.packageRoot },
    );
    await copyDeclarations(context);
  },
};
