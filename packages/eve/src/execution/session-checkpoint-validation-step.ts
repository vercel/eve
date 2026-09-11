import { deserializeContext } from "#context/serialize.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import type { SessionCheckpoint } from "#execution/session-handoff.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

/** Validates a checkpoint and resolves the target deployment's compiled bundle. */
export async function validateSessionCheckpointStep(input: {
  readonly checkpoint: SessionCheckpoint;
}): Promise<void> {
  "use step";
  const { hooks } = input.checkpoint;
  if (
    hooks.session.length === 0 ||
    hooks.session.some((token) => typeof token !== "string" || token.length === 0) ||
    new Set(hooks.session).size !== hooks.session.length
  ) {
    throw new Error("Session checkpoint contains an invalid hook claim set.");
  }
  const continuationToken = input.checkpoint.sessionState.continuationToken;
  if (continuationToken !== "" && !hooks.session.includes(continuationToken)) {
    throw new Error("Session checkpoint does not claim its current continuation address.");
  }
  const context = await deserializeContext(input.checkpoint.serializedContext);
  context.require(BundleKey);
  readDurableSession(input.checkpoint.sessionState);
}
