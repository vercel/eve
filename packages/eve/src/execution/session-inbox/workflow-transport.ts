import { createHook, getWorkflowMetadata, type Hook } from "#compiled/@workflow/core/index.js";
import {
  SESSION_INBOX_SESSION_ID_METADATA_KEY,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { SessionInboxPayload, SessionInboxTransport } from "#execution/session-inbox/inbox.js";
import {
  claimHookOwnership,
  disposeHook,
  isHookForceClaimedError,
} from "#execution/hook-ownership.js";
import type { WorkflowToolRunMessageBatch } from "#execution/tools/workflow/messages.js";

export type SessionHook = Hook<SessionInboxPayload | WorkflowToolRunMessageBatch>;

export function workflowInboxTransport(sessionId: string): SessionInboxTransport<SessionHook> {
  return {
    open: (token, { claimedAtStart, force }) =>
      createHook<SessionInboxPayload | WorkflowToolRunMessageBatch>(
        claimedAtStart
          ? { token: sessionInboxHookToken(token) }
          : {
              token: sessionInboxHookToken(token),
              metadata: { [SESSION_INBOX_SESSION_ID_METADATA_KEY]: sessionId },
              ...(force && { experimental_force: true }),
            },
      ),
    confirm: (hook) => claimHookOwnership(hook),
    dispose: (hook) => disposeHook(hook),
    isTakenOver: (error) => isHookForceClaimedError(error),
    ownerRunId: () => getWorkflowMetadata().workflowRunId,
    now: () => Date.now(),
  };
}
