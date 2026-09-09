import { createHook } from "#compiled/@workflow/core/index.js";

import type { HistoryAppendCommandResult } from "#channel/types.js";
import { disposeHook } from "#execution/hook-ownership.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import type { HistoryMessage } from "#shared/history-message.js";

export interface SessionHistoryAppendWorkflowInput {
  readonly messages: readonly HistoryMessage[];
  readonly operationId: string;
  readonly sessionId: string;
}

/** Waits for the target session to commit or reject one history mutation. */
export async function sessionHistoryAppendWorkflow(
  input: SessionHistoryAppendWorkflowInput,
): Promise<HistoryAppendCommandResult> {
  "use workflow";

  const acknowledgement = createHook<HistoryAppendCommandResult>();
  try {
    await dispatchHistoryAppendStep({ ...input, replyTo: acknowledgement.token });
    return await acknowledgement;
  } finally {
    await disposeHook(acknowledgement);
  }
}

async function dispatchHistoryAppendStep(
  input: SessionHistoryAppendWorkflowInput & { readonly replyTo: string },
): Promise<void> {
  "use step";

  await resumeSessionInbox(sessionCommandHookToken(input.sessionId), {
    kind: "append-history",
    messages: input.messages,
    operationId: input.operationId,
    replyTo: input.replyTo,
  });
}
