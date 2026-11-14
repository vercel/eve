import type { Actors } from "#execution/actor/actors.js";
import { worldActors } from "#execution/actor/world/world-actors.js";
import type { RuntimeWorld } from "./runtime-world.js";

// Sessions as actors on a World: a session's id is its key (`session_` and a ULID), its
// journal holds what it continues from, its stream its lines, and its mailbox what a World host's
// callers send it.

/** The workflow name a session's run carries, so a list of runs finds sessions. */
export const SESSION_RUN_WORKFLOW_NAME = "eve/in-process-session";

/** The queue namespace a World host's activations travel in, unless it's given another. */
export const SESSION_QUEUE_NAMESPACE = "evesession";

const cache = new WeakMap<RuntimeWorld, Map<string, Actors>>();

/**
 * The sessions on `world`, as actors: one per World and queue namespace, so its handles are
 * shared. A deployed agent's activations travel in its own namespace, which its queue function's
 * trigger names.
 */
export function sessionActors(
  world: RuntimeWorld,
  queueNamespace: string = SESSION_QUEUE_NAMESPACE,
): Actors {
  let byNamespace = cache.get(world);
  if (byNamespace === undefined) cache.set(world, (byNamespace = new Map()));
  let actors = byNamespace.get(queueNamespace);
  if (actors === undefined)
    byNamespace.set(
      queueNamespace,
      (actors = worldActors(world, {
        kind: "session",
        queueNamespace,
        streamNamespace: "eve-lines",
        workflowName: SESSION_RUN_WORKFLOW_NAME,
      })),
    );
  return actors;
}
