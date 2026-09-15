import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import { createSessionInbox, type SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";

export async function sessionCommandInboxWorkflow(input: {
  readonly messageCount?: number;
  readonly nextToken?: string;
  readonly token: string;
}): Promise<string[]> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const inbox = createSessionInbox(workflowRunId);

  try {
    await inbox.claimSessionHook(sessionCommandHookToken(workflowRunId));
    await inbox.claimSessionHook(input.token);
    const pending = inbox.read();
    if (input.nextToken !== undefined) {
      await inbox.claimSessionHook(input.nextToken);
    }

    const messages: string[] = [];
    let lease = await pending;
    while (true) {
      if (lease === undefined) return messages;
      lease.consume();
      if (lease.value.kind === "reset") return messages;
      collectMessage(lease.value, messages);
      if (messages.length >= (input.messageCount ?? 2)) return messages;
      lease = await inbox.read();
    }
  } finally {
    await inbox.dispose();
  }
}

function collectMessage(command: SessionInboxPayload, messages: string[]): void {
  if (command.kind === "send" && typeof command.payload.message === "string") {
    messages.push(command.payload.message);
  }
  if (command.kind === "deliver" && typeof command.payloads[0]?.message === "string") {
    messages.push(command.payloads[0].message);
  }
}
