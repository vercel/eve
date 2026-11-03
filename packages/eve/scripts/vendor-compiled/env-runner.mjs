import { fileURLToPath } from "node:url";

import { loadDeclaration } from "./_shared.mjs";

/**
 * Vendor config for `env-runner`, which hosts Nitro's development entry in a
 * worker thread. Only public subpaths are vendored: `RunnerManager` and the
 * Node worker runner for eve's dev host supervisor, and the worker entry,
 * which bundles the srvx and crossws versions Nitro's entry is built against.
 */
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
