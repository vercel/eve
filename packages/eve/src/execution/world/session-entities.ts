import type { Entities } from "#execution/entity/entities.js";
import { worldEntities } from "#execution/entity/world/world-entities.js";
import type { RuntimeWorld } from "./runtime-world.js";

// Sessions as entities on a World: a session's id is its key (`session_` and a ULID), its
// journal holds what it continues from, its stream its lines, and its mailbox what a World host's
// callers send it.

/** The workflow name a session's run carries, so a list of runs finds sessions. */
export const SESSION_RUN_WORKFLOW_NAME = "eve/in-process-session";

/** The queue namespace a World host's activations travel in, unless it's given another. */
export const SESSION_QUEUE_NAMESPACE = "evesession";

const cache = new WeakMap<RuntimeWorld, Map<string, Entities>>();

/**
 * The sessions on `world`, as entities: one per World and queue namespace, so its handles are
 * shared. A deployed agent's activations travel in its own namespace, which its queue function's
 * trigger names.
 */
export function sessionEntities(
  world: RuntimeWorld,
  queueNamespace: string = SESSION_QUEUE_NAMESPACE,
): Entities {
  let byNamespace = cache.get(world);
  if (byNamespace === undefined) cache.set(world, (byNamespace = new Map()));
  let entities = byNamespace.get(queueNamespace);
  if (entities === undefined)
    byNamespace.set(
      queueNamespace,
      (entities = worldEntities(world, {
        kind: "session",
        queueNamespace,
        streamNamespace: "eve-lines",
        workflowName: SESSION_RUN_WORKFLOW_NAME,
      })),
    );
  return entities;
}
