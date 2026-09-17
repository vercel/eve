import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { getWorld } from "#internal/workflow/runtime.js";

/** Commit disposal before readers stop: Workflow delivers earlier hook events before this step resolves. */
export async function releaseSessionHooksStep(input: {
  readonly ownerRunId: string;
  readonly tokens: readonly string[];
}): Promise<void> {
  "use step";

  const world = await getWorld();
  const outcomes = await Promise.allSettled(
    input.tokens.map(async (token) => {
      let hook;
      try {
        hook = await world.hooks.getByToken(token);
      } catch (error) {
        if (HookNotFoundError.is(error)) return;
        throw error;
      }
      if (hook.runId !== input.ownerRunId) {
        throw new Error("Cannot release a session hook owned by another workflow.");
      }
      await world.events.create(input.ownerRunId, {
        correlationId: hook.hookId,
        eventData: { token },
        eventType: "hook_disposed",
        specVersion: hook.specVersion,
      });
    }),
  );
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
}
