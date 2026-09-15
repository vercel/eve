import { deserializeContext } from "#context/serialize.js";
import { isSessionStateIdleForHandoff } from "#execution/session-handoff-state.js";
import { SESSION_CHECKPOINT_VERSION, type SessionCheckpoint } from "#execution/session-handoff.js";
import { flattenSessionHookClaims } from "#execution/session-hook-claims.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

/** Validates a checkpoint and resolves the target deployment's compiled bundle. */
export async function validateSessionCheckpointStep(input: {
  readonly checkpoint: SessionCheckpoint;
}): Promise<void> {
  "use step";
  const { checkpoint } = input;
  if (checkpoint.version !== SESSION_CHECKPOINT_VERSION) {
    throw new Error(
      `Unsupported session checkpoint version ${JSON.stringify(checkpoint.version)}; this deployment reads version ${SESSION_CHECKPOINT_VERSION}. Start a new session on this deployment.`,
    );
  }
  const timeout = checkpoint.sessionTimeoutMs;
  if (
    timeout !== false &&
    (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)
  )
    throw new Error("Session checkpoint contains an invalid timeout duration.");
  const { hooks } = checkpoint;
  const tokens = flattenSessionHookClaims(hooks);
  if (
    typeof hooks.stable !== "string" ||
    hooks.stable.length === 0 ||
    !Array.isArray(hooks.aliases) ||
    tokens.some((token) => typeof token !== "string" || token.length === 0) ||
    new Set(tokens).size !== tokens.length
  ) {
    throw new Error("Session checkpoint contains an invalid hook claim set.");
  }
  const continuationToken = checkpoint.sessionState.continuationToken;
  if (continuationToken !== "" && !tokens.includes(continuationToken)) {
    throw new Error("Session checkpoint does not claim its current continuation address.");
  }
  const context = await deserializeContext(checkpoint.serializedContext);
  context.require(BundleKey);
  if (!isSessionStateIdleForHandoff(checkpoint.sessionState)) {
    throw new Error("Session checkpoint contains pending work and cannot be handed off.");
  }
}
