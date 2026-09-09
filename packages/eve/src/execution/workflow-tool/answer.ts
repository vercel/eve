import type { InboxReplyTarget } from "#execution/inbox/types.js";
import { sendInbox } from "#execution/inbox/send.js";
import type { InputResponse } from "#shared/input.js";
import type { ToolInputResponse } from "#tools/definition.js";

export async function resumeWorkflowToolRunAnswers(
  target: InboxReplyTarget,
  responses: readonly InputResponse[] | undefined,
): Promise<void> {
  for (const response of responses ?? []) {
    const answer: ToolInputResponse = { optionId: response.optionId, text: response.text };
    await sendInbox(target.address, {
      eventId: `${target.requestId}:answer:${response.requestId}`,
      kind: "tool.response",
      payload: answer,
      requestId: target.requestId,
    });
  }
}
