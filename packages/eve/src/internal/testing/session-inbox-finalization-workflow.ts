import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { createSessionInbox } from "#execution/session-inbox/inbox.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";

/**
 * Ends a session's inbox the way finalization does, then claims its address
 * again, as the state cursor does for every step finalization still runs.
 * The run then parks on `finishToken`, so a test can probe the address.
 */
export async function sessionInboxFinalizationWorkflow(input: {
  readonly endToken: string;
  readonly finishToken: string;
}): Promise<void> {
  "use workflow";
  const stable = sessionCommandHookToken(getWorkflowMetadata().workflowRunId);
  const inbox = createSessionInbox(getWorkflowMetadata().workflowRunId);
  await inbox.claimSessionHook(stable);
  {
    using end = createHook<void>({ token: input.endToken });
    await end;
  }
  await inbox.dispose();
  await inbox.claimSessionHooks([stable]);
  using finish = createHook<void>({ token: input.finishToken });
  await finish;
}
