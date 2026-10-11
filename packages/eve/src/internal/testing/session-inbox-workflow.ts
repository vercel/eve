import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import { createSessionInbox } from "#execution/session-inbox/inbox.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";

export async function sessionCommandInboxWorkflow(input: {
  /** Session whose stable inbox this owner holds; a handoff successor names its anchor. */
  readonly sessionId?: string;
  readonly token: string;
}): Promise<void> {
  "use workflow";

  const sessionId = input.sessionId ?? getWorkflowMetadata().workflowRunId;
  const inbox = createSessionInbox(sessionId);

  try {
    await inbox.claimSessionHook(sessionCommandHookToken(sessionId));
    await inbox.claimSessionHook(input.token);
    while (true) {
      const payload = await inbox.next();
      if (payload === undefined || payload.kind === "reset") return;
    }
  } finally {
    await inbox.dispose();
  }
}

/** Parks like a session anchor after a handoff: it holds no session address of its own. */
export async function parkedAnchorWorkflow(input: { readonly token: string }): Promise<void> {
  "use workflow";

  using gate = createHook<void>({ token: input.token });
  await gate;
}
