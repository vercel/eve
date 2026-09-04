import { isHookConflictError } from "#execution/hook-ownership.js";
import type { SessionCommandInbox } from "#execution/session-command-inbox.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { publishWorkflowOwnershipStep } from "#execution/workflow-lifecycle-step.js";

/** Claims the session's inboxes and acknowledges the winner before session initialization settles. */
export async function claimSessionInbox(input: {
  readonly acknowledgeOwnership?: boolean;
  readonly commandInbox: SessionCommandInbox;
  readonly continuationToken: string;
  readonly sessionId: string;
}): Promise<PromiseSettledResult<void>> {
  const [stableClaim, authorizationClaim, continuationClaim] = await Promise.allSettled([
    input.commandInbox.claimStable(sessionCommandHookToken(input.sessionId)),
    input.commandInbox.claimAuthorization(`${input.sessionId}:auth`),
    input.commandInbox.rekeyContinuation(input.continuationToken),
  ]);
  if (stableClaim.status === "rejected") throw stableClaim.reason;
  if (authorizationClaim.status === "rejected") throw authorizationClaim.reason;
  if (input.acknowledgeOwnership === true) {
    let runId = input.sessionId;
    if (continuationClaim.status === "rejected") {
      const error = continuationClaim.reason;
      if (!isHookConflictError(error) || typeof error.conflictingRunId !== "string") throw error;
      runId = error.conflictingRunId;
    }
    await publishWorkflowOwnershipStep({ runId });
  }
  return continuationClaim;
}
