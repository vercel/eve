import { fileURLToPath } from "node:url";

import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "env-runner",
  compiledPath: "env-runner",
  entries: [
    {
      input: fileURLToPath(new URL("./entries/env-runner.mjs", import.meta.url)),
      outputPath: "index",
      declaration: await loadDeclaration("env-runner.d.ts"),
    },
    {
      entry: "dist/runners/node-worker/worker.mjs",
      outputPath: "node-worker",
      declaration: "export {};\n",
    },
  ],
};
