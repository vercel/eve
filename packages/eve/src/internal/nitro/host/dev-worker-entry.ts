// Installs eve's package-import hook in the worker thread before the env
// runner's worker loads the Nitro host, which imports most of eve.
import "../../package-imports-hook.js";

await import("#compiled/env-runner/node-worker.js");
