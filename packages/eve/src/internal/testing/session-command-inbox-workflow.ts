import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import {
  createSessionCommandInbox,
  type SessionInboxPayload,
} from "#execution/session-command-inbox.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";

export async function sessionCommandInboxWorkflow(input: {
  readonly messageCount?: number;
  readonly nextToken?: string;
  readonly token: string;
}): Promise<string[]> {
  "use workflow";

  const inbox = createSessionCommandInbox();
  const { workflowRunId } = getWorkflowMetadata();

  try {
    await inbox.claimStable(sessionCommandHookToken(workflowRunId));
    await inbox.rekeyContinuation(input.token);
    const pending = inbox.next();
    if (input.nextToken !== undefined) {
      await inbox.rekeyContinuation(input.nextToken);
    }

    const messages: string[] = [];
    let next = await pending;
    while (true) {
      inbox.consumeNext();
      if (next.done || next.value.kind === "reset") return messages;
      collectMessage(next.value, messages);
      if (messages.length >= (input.messageCount ?? 2)) return messages;
      next = await inbox.next();
    }
  } finally {
    await inbox.dispose();
  }
}

function collectMessage(command: SessionInboxPayload, messages: string[]): void {
  if (command.kind === "send" && typeof command.payload.message === "string") {
    messages.push(command.payload.message);
  }
}
