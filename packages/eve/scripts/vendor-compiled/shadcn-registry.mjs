import { fileURLToPath } from "node:url";

import { loadDeclaration } from "./_shared.mjs";

const declaration = await loadDeclaration("shadcn-registry.d.ts");

// Rolldown miscompiles tsconfig-paths' CommonJS JSON5 namespace import after minification.
// Parse tsconfig's JSONC syntax through an explicit ESM module instead.
const json5ShimPlugin = {
  name: "eve-json5-shim",
  resolveId(source) {
    return source === "json5" ? "eve-json5-shim" : undefined;
  },
  load(id) {
    if (id !== "eve-json5-shim") return undefined;
    return {
      code: `
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
export function parse(source) {
  const errors = [];
  const value = parseJsonc(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const error = errors[0];
    throw new SyntaxError(printParseErrorCode(error.error) + " at offset " + error.offset);
  }
  return value;
}
export default { parse };
`,
      moduleType: "js",
    };
  },
};

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
  plugins: [json5ShimPlugin],
  banner: `/* oxlint-disable */
import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
const __filename = __eveFileURLToPath(import.meta.url);
const __dirname = __eveDirname(__filename);`,
};
