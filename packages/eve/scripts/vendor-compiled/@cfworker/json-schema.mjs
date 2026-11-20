import { loadDeclaration } from "../_shared.mjs";

export default {
  packageName: "@cfworker/json-schema",
  compiledPath: "@cfworker/json-schema",
  bundling: "standalone",
  platform: "neutral",
  declaration: await loadDeclaration("@cfworker/json-schema.d.ts"),
};
