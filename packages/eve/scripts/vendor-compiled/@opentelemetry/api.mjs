import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { loadDeclaration } from "../_shared.mjs";

const require = createRequire(import.meta.url);
const commonJsEntry = require.resolve("@opentelemetry/api");
const esmEntry = join(dirname(commonJsEntry), "..", "esm", "index.js");

const preserveApiSingleton = {
  name: "eve:preserve-opentelemetry-api-singleton",
  resolveId(source) {
    return source === "@opentelemetry/api" ? esmEntry : null;
  },
};

export default {
  packageName: "@opentelemetry/api",
  compiledPath: "@opentelemetry/api",
  entry: "build/esm/index.js",
  declaration: await loadDeclaration("@opentelemetry/api.d.ts"),
  plugins: [preserveApiSingleton],
};
