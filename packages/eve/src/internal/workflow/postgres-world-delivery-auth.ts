import type { World } from "#compiled/@workflow/world/index.js";

type QueueWorld = Pick<World, "createQueueHandler" | "registerHandler">;

/**
 * Postgres workers deliver database jobs through registered in-process handlers.
 * Trust the Request object only while that delivery is active, never HTTP headers
 * or the apparent source address. This also covers recovery and retries, which
 * the Postgres world enqueues internally rather than through `world.queue`.
 */
export function authenticatePostgresWorkflowDeliveries<TWorld extends QueueWorld>(
  world: TWorld,
): TWorld {
  if (typeof world.registerHandler !== "function") {
    throw new Error(
      "The Postgres Workflow world must support in-process queue delivery. " +
        "Install @workflow/world-postgres@^5.0.5 and rebuild the agent.",
    );
  }

  const deliveries = new WeakSet<Request>();
  const registerHandler = world.registerHandler.bind(world);
  world.registerHandler = (prefix, handler) =>
    registerHandler(prefix, async (request) => {
      deliveries.add(request);
      try {
        return await handler(request);
      } finally {
        deliveries.delete(request);
      }
    });

  const createQueueHandler = world.createQueueHandler.bind(world);
  world.createQueueHandler = (prefix, handler) => {
    const deliver = createQueueHandler(prefix, handler);
    return async (request) => {
      if (!deliveries.has(request)) {
        return Response.json({ error: "Untrusted workflow delivery." }, { status: 401 });
      }
      return await deliver(request);
    };
  };
  return world;
}
