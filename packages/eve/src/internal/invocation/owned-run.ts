import type { SessionAuthContext } from "#channel/types.js";
import { requireDurableHost, type DurableRun } from "#execution/hosts.js";
import {
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
  invocationOwnerKey,
} from "#internal/invocation/metadata.js";

export async function readOwnedInvocationRun(
  sessionId: string,
  auth: SessionAuthContext | null,
): Promise<DurableRun | undefined> {
  const run = await requireDurableHost().findRun(sessionId);
  if (run?.attributes[INVOCATION_TOKEN_ATTRIBUTE] === undefined) return undefined;
  return run.attributes[INVOCATION_OWNER_ATTRIBUTE] === invocationOwnerKey(auth) ? run : undefined;
}

export function invocationContinuationToken(run: DurableRun): string | undefined {
  return run.attributes[INVOCATION_TOKEN_ATTRIBUTE];
}
