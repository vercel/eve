import type { World } from "#compiled/@workflow/world/index.js";
import type { RuntimeWorld } from "./runtime-world.js";

// Every Workflow World is a `RuntimeWorld`: this doesn't compile if a World stops fitting the part
// of its interface eve uses. Type-only, so it loads nothing of Workflow's.

/** `world`, as eve's in-process host reads and writes it. */
export function asRuntimeWorld(world: World): RuntimeWorld {
  return world;
}
