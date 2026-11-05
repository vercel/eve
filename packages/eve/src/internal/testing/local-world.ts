import { localWorld } from "#execution/world/local-world.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";

/** Workflow's local World in `directory`, as `eve/experimental/embed`'s `localWorld()` opens it. */
export function localTestWorld(directory: string): RuntimeWorld {
  return localWorld({ dataDir: directory });
}
