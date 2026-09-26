import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import { createSessionInbox } from "#execution/session-inbox/inbox.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";

export async function sessionCommandInboxWorkflow(input: {
  readonly token: string;
}): Promise<void> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const inbox = createSessionInbox(workflowRunId);

  try {
    await inbox.claimSessionHook(sessionCommandHookToken(workflowRunId));
    await inbox.claimSessionHook(input.token);
    while (true) {
      const payload = await inbox.next();
      if (payload === undefined || payload.kind === "reset") return;
    }
  } finally {
    await inbox.dispose();
  }
}
