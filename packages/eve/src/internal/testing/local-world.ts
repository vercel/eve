import { createWorld } from "#compiled/@workflow/world-local/index.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import { asRuntimeWorld } from "#execution/world/world-fit.js";

/** Workflow's local World in `directory`, as an in-process runtime keeps sessions on it. */
export function localTestWorld(directory: string): RuntimeWorld {
  return asRuntimeWorld(createWorld({ dataDir: directory, recoverActiveRuns: false }));
}
