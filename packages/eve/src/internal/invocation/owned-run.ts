import type { SessionAuthContext } from "#channel/types.js";
import { findWorkflowRun, type WorkflowRun } from "#execution/workflow-host/host.js";
import {
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
  invocationOwnerKey,
} from "#internal/invocation/metadata.js";

export async function readOwnedInvocationRun(
  sessionId: string,
  auth: SessionAuthContext | null,
): Promise<WorkflowRun | undefined> {
  const run = await findWorkflowRun(sessionId);
  if (run?.attributes[INVOCATION_TOKEN_ATTRIBUTE] === undefined) return undefined;
  return run.attributes[INVOCATION_OWNER_ATTRIBUTE] === invocationOwnerKey(auth) ? run : undefined;
}

export function invocationContinuationToken(run: WorkflowRun): string | undefined {
  return run.attributes[INVOCATION_TOKEN_ATTRIBUTE];
}
