import { createGracefulNodeWorkerShutdownPlugin } from "./env-runner.mjs";

/**
 * env-runner's worker-thread entry resolved for Bun: `srvx` serves through
 * `Bun.serve` and `crossws/server` attaches the Bun WebSocket adapter. The
 * Node build throws in Bun, where crossws rejects its Node adapter.
 */
export default {
  packageName: "env-runner",
  compiledPath: "env-runner-bun-worker",
  bundling: "standalone",
  entry: "dist/runners/node-worker/worker.mjs",
  plugins: [createGracefulNodeWorkerShutdownPlugin()],
  resolve: { conditionNames: ["bun"], mainFields: ["module", "main"] },
  declaration: "export {};\n",
};
