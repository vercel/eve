import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { createSessionCommandInbox } from "#execution/session-command-inbox.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";

export async function sessionHookPumpWorkflow(input: {
  readonly aliases: readonly string[];
  readonly releaseToken: string;
}): Promise<unknown[]> {
  "use workflow";
  const inbox = createSessionCommandInbox(getWorkflowMetadata().workflowRunId);
  using gate = createHook<void>({ token: input.releaseToken });
  try {
    await inbox.claimSessionHook(sessionCommandHookToken(getWorkflowMetadata().workflowRunId));
    for (const token of input.aliases) await inbox.claimSessionHook(token);
    await gate;
    return await recordPumpedMessages(inbox.drain());
  } finally {
    await inbox.dispose();
  }
}

async function recordPumpedMessages(messages: readonly unknown[]): Promise<unknown[]> {
  "use step";
  return [...messages];
}
