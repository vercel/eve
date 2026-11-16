import { RunExpiredError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";

import type { SessionAuthContext } from "#channel/types.js";
import {
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
  invocationOwnerKey,
} from "#internal/invocation/metadata.js";
import { getWorld } from "#internal/workflow/runtime.js";

/**
 * The session run behind an external invocation, when `auth` started it.
 *
 * Unknown, expired, non-invocation, and foreign-principal runs all read as `undefined`, so a
 * caller can't tell another caller's invocation from one that doesn't exist.
 */
export async function readOwnedInvocationRun(sessionId: string, auth: SessionAuthContext | null) {
  const world = await getWorld();
  try {
    const run = await world.runs.get(sessionId);
    if (run.attributes[INVOCATION_TOKEN_ATTRIBUTE] === undefined) return undefined;
    return run.attributes[INVOCATION_OWNER_ATTRIBUTE] === invocationOwnerKey(auth)
      ? run
      : undefined;
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error) || RunExpiredError.is(error)) return undefined;
    throw error;
  }
}

/** The continuation token (channel-local address) an owned invocation run answers on. */
export function invocationContinuationToken(
  run: NonNullable<Awaited<ReturnType<typeof readOwnedInvocationRun>>>,
): string | undefined {
  return run.attributes[INVOCATION_TOKEN_ATTRIBUTE];
}
