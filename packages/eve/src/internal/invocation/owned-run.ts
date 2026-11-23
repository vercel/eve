import {
  RunExpiredError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from "#compiled/@workflow/errors/index.js";

import type { SessionAuthContext } from "#channel/types.js";
import {
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
  invocationOwnerKey,
} from "#internal/invocation/metadata.js";
import { getWorld } from "#internal/workflow/runtime.js";

export async function readOwnedInvocationRun(sessionId: string, auth: SessionAuthContext | null) {
  const world = await getWorld();
  try {
    const run = await world.runs.get(sessionId);
    if (run.attributes[INVOCATION_TOKEN_ATTRIBUTE] === undefined) return undefined;
    return run.attributes[INVOCATION_OWNER_ATTRIBUTE] === invocationOwnerKey(auth)
      ? run
      : undefined;
  } catch (error) {
    if (isMissingRun(error)) return undefined;
    throw error;
  }
}

function isMissingRun(error: unknown): boolean {
  return (
    WorkflowRunNotFoundError.is(error) ||
    RunExpiredError.is(error) ||
    isUnsafeEntityIdError(error) ||
    (WorkflowWorldError.is(error) && error.status === 400)
  );
}

function isUnsafeEntityIdError(error: unknown): boolean {
  return error instanceof Error && error.name === "UnsafeEntityIdError";
}

export function invocationContinuationToken(
  run: NonNullable<Awaited<ReturnType<typeof readOwnedInvocationRun>>>,
): string | undefined {
  return run.attributes[INVOCATION_TOKEN_ATTRIBUTE];
}
