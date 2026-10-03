import { fileURLToPath } from "node:url";

import { loadDeclaration } from "./_shared.mjs";

/**
 * Vendor config for `js-yaml` v4. Only `load` is vendored: v4's default
 * schema has no code-evaluating `!!js/*` types, so eve can parse untrusted
 * YAML without an esprima dependency or a guard around the parser.
 */
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
