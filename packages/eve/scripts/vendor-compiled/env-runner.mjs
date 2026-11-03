import { loadDeclaration } from "./_shared.mjs";

/**
 * Vendor config for `env-runner`, which hosts Nitro's development entry in a
 * worker thread. Only its public Node worker subpaths are vendored: the
 * runner class for eve's dev server, and the worker entry, which bundles the
 * srvx and crossws versions Nitro's entry is built against.
 */
export default {
  packageName: "env-runner",
  compiledPath: "env-runner",
  entries: [
    {
      entry: "dist/runners/node-worker/runner.mjs",
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
