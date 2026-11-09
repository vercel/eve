// An agent built to run on a World host (experimental): `EVE_EXPERIMENTAL_WORLD_HOST=1` at build.
// Kept apart from the World host (`routes/world-host.ts`), which build-time code doesn't load.

/** Set at build: the agent's sessions run on a World host. */
export const EVE_WORLD_HOST_ENV = "EVE_EXPERIMENTAL_WORLD_HOST";

/** Whether this build runs its agent's sessions on a World host. */
export function buildsForWorldHost(): boolean {
  return process.env[EVE_WORLD_HOST_ENV] === "1";
}

/** The route a World host's queue function serves: its activations. */
export const EVE_WORLD_HOST_QUEUE_ROUTE_PATH = "/.well-known/eve/v1/world-host/queue";
