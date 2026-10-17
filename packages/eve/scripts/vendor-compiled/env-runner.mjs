import { loadDeclaration } from "./_shared.mjs";

const ENV_RUNNER_SHUTDOWN_SOURCE =
  "Promise.resolve(entry.ipc?.onClose?.()).then(() => server.close()).then(() => {";
const EVE_SHUTDOWN_SOURCE =
  "Promise.resolve(server.close(true)).then(() => entry.ipc?.onClose?.()).then(() => {";
const ENV_RUNNER_EXIT_SOURCE = 'parentPort?.postMessage({ event: "exit" });';
const EVE_EXIT_SOURCE = `${ENV_RUNNER_EXIT_SOURCE}\n      parentPort?.close();`;

// env-runner proxies through httpxy's shared keep-alive agent, which never
// expires idle sockets. A busy parent can then reuse one the worker already
// closed and fail the forward (#5001). `agent: false` opens a fresh loopback
// connection per request instead.
const ENV_RUNNER_FETCH_SOURCE =
  "return proxyFetch(this._address, this._resolveFetchInput(input), init);";
const EVE_FETCH_SOURCE =
  "return proxyFetch(this._address, this._resolveFetchInput(input), init, { agent: false });";

function createFreshWorkerConnectionPlugin() {
  let patched = false;

  return {
    name: "eve-env-runner-fresh-worker-connection",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/_chunks/common-base-runner.mjs")) {
        return null;
      }
      if (!code.includes(ENV_RUNNER_FETCH_SOURCE)) {
        throw new Error("env-runner's worker fetch contract changed.");
      }
      patched = true;
      return { code: code.replace(ENV_RUNNER_FETCH_SOURCE, EVE_FETCH_SOURCE), map: null };
    },
    buildEnd() {
      if (!patched) {
        throw new Error("env-runner's worker fetch was not patched.");
      }
    },
  };
}

function createGracefulNodeWorkerShutdownPlugin() {
  let patched = false;

  return {
    name: "eve-env-runner-graceful-node-worker-shutdown",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/runners/node-worker/worker.mjs")) {
        return null;
      }
      if (!code.includes(ENV_RUNNER_SHUTDOWN_SOURCE)) {
        throw new Error("env-runner's Node worker shutdown contract changed.");
      }
      if (!code.includes(ENV_RUNNER_EXIT_SOURCE)) {
        throw new Error("env-runner's Node worker exit contract changed.");
      }
      patched = true;
      return {
        code: code
          .replace(ENV_RUNNER_SHUTDOWN_SOURCE, EVE_SHUTDOWN_SOURCE)
          .replace(ENV_RUNNER_EXIT_SOURCE, EVE_EXIT_SOURCE),
        map: null,
      };
    },
    buildEnd() {
      if (!patched) {
        throw new Error("env-runner's Node worker entry was not patched.");
      }
    },
  };
}

export default {
  packageName: "env-runner",
  compiledPath: "env-runner",
  plugins: [createFreshWorkerConnectionPlugin(), createGracefulNodeWorkerShutdownPlugin()],
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
