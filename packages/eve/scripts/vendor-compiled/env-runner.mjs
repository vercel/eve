import { loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "env-runner",
  compiledPath: "env-runner",
  entries: [
    {
      entry: "dist/_chunks/common-base-runner.mjs",
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
