import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { loadDeclaration } from "../_shared.mjs";

const require = createRequire(import.meta.url);
const commonJsEntry = require.resolve("@opentelemetry/api");
const esmEntry = join(dirname(commonJsEntry), "..", "esm", "index.js");

// @vercel/otel requests the CommonJS condition, but every vendored consumer must
// share the ESM entrypoint's proxy while producing an ESM public surface.
const preserveApiSingleton = {
  name: "eve:preserve-opentelemetry-api-singleton",
  resolveId(source) {
    return source === "@opentelemetry/api" ? esmEntry : null;
  },
};

export default {
  packageName: "@opentelemetry/api",
  compiledPath: "@opentelemetry/api",
  chunkGroup: "workflow",
  entry: "build/esm/index.js",
  declaration: await loadDeclaration("@opentelemetry/api.d.ts"),
  plugins: [preserveApiSingleton],
};
