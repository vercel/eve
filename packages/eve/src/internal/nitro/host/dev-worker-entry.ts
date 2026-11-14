// Installs eve's package-import hook in the worker thread before the env
// runner's worker loads the Nitro host, which imports most of eve. Under
// `eve dev` the worker already inherits it from the dev server's `--import`;
// this covers `eve eval`, which starts the dev server inside the CLI process,
// where bin/eve.js installed the hook in code and no `--import` carries it.
import "../../package-imports-hook.js";

await import("#compiled/env-runner/node-worker.js");
