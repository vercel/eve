import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { getHookByToken, getWorld } from "#internal/workflow/runtime.js";
import { EVE_PREWARM_ATTRIBUTE } from "#execution/eve-workflow-attributes.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import type { PrewarmSessionResult } from "#protocol/prewarm-session.js";

/** Internal hint, scoped to the owner inspected by ingress to avoid stale transfers. */
export interface SessionPrewarmPayload {
  readonly kind: "session-prewarm";
  readonly expectedOwnerRunId: string;
  readonly targetDeploymentId: string;
}

export async function prewarmWorkflowSession(
  sessionId: string,
  targetDeploymentId: string | undefined,
): Promise<PrewarmSessionResult> {
  if (
    targetDeploymentId === undefined ||
    targetDeploymentId.length === 0 ||
    targetDeploymentId === "latest"
  )
    return { status: "unsupported" };
  const world = await getWorld();
  // Single-build Worlds cannot proactively migrate an owner to another build.
  if (world.capabilities?.deploymentAffinity !== true) return { status: "unsupported" };
  let hook;
  try {
    hook = await getHookByToken(sessionInboxHookToken(sessionCommandHookToken(sessionId)));
  } catch (error) {
    if (HookNotFoundError.is(error)) return { status: "no_active_session" };
    throw error;
  }
  const owner = await world.runs.get(hook.runId, { resolveData: "none" });
  if (owner.status !== "running" && owner.status !== "pending")
    return { status: "no_active_session" };
  if (owner.deploymentId === targetDeploymentId) return { status: "ready" };
  // Never wake an older owner with an inbox payload it cannot decode.
  if (owner.attributes[EVE_PREWARM_ATTRIBUTE] !== "1") return { status: "unsupported" };
  await resumeSessionInbox(
    { sessionId },
    { kind: "session-prewarm", expectedOwnerRunId: hook.runId, targetDeploymentId },
  );
  return { status: "accepted" };
}
