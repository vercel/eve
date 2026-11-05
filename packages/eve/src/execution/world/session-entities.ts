import type { Entities } from "#execution/entity/entities.js";
import { worldEntities } from "#execution/entity/world/world-entities.js";
import type { RuntimeWorld } from "./runtime-world.js";

// Sessions as entities on a World: a session's id is its key (`session_` and a ULID), its
// journal holds what it continues from, its stream its lines, and its mailbox what a World host's
// callers send it.

/** The workflow name a session's run carries, so a list of runs finds sessions. */
export const SESSION_RUN_WORKFLOW_NAME = "eve/in-process-session";

/** The queue namespace a World host's activations travel in. */
export const SESSION_QUEUE_NAMESPACE = "evesession";

const cache = new WeakMap<RuntimeWorld, Entities>();

/** The sessions on `world`, as entities: one per World, so its handles are shared. */
export function sessionEntities(world: RuntimeWorld): Entities {
  let entities = cache.get(world);
  if (entities === undefined)
    cache.set(
      world,
      (entities = worldEntities(world, {
        kind: "session",
        queueNamespace: SESSION_QUEUE_NAMESPACE,
        streamNamespace: "eve-lines",
        workflowName: SESSION_RUN_WORKFLOW_NAME,
      })),
    );
  return entities;
}
