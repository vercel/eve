import type { SessionAuthContext } from "#channel/types.js";
import {
  createFrameworkUserMessage,
  type HarnessModelMessage,
  type UserModelMessage,
} from "#harness/messages.js";
import { projectTaskResultBody } from "#harness/tool-model-output.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import { RESULT_TURN_REPLY_PROMPT, renderTaskResults } from "#tasks/render.js";
import { takeTaskResults } from "#tasks/results.js";

/**
 * Takes the deliverable background results created by `principal` and
 * renders them as one `task.result` message. The records are marked
 * delivered in the returned session, so the message and the marks commit
 * together with the step.
 */
export async function takeTaskResultMessage(input: {
  readonly principal: SessionAuthContext | null;
  readonly session: HarnessSession;
  readonly tools: HarnessToolMap;
}): Promise<
  | {
      readonly message: UserModelMessage;
      readonly session: HarnessSession;
      readonly taskIds: readonly string[];
    }
  | undefined
> {
  const taken = takeTaskResults(input.session, input.principal);
  if (taken.results.length === 0) return undefined;
  const blocks = await Promise.all(
    taken.results.map(async (result) => ({
      body: await projectTaskResultBody(result, input.tools),
      outcome: result.outcome,
      record: { id: result.taskId, name: result.name },
    })),
  );
  return {
    message: createFrameworkUserMessage("task.result", renderTaskResults(blocks)),
    session: taken.session,
    taskIds: taken.results.map((result) => result.taskId),
  };
}

/**
 * Whether the turn delivered task results and has not replied. A result turn
 * must produce a reply, so eve asks once and then accepts whatever comes.
 */
export function needsResultTurnReply(history: readonly HarnessModelMessage[]): boolean {
  let replied = false;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.role === "assistant") {
      replied ||= hasText(message);
      continue;
    }
    if (message.role !== "user") continue;
    if (message.kind === "execution.continuation" && message.content === RESULT_TURN_REPLY_PROMPT) {
      return false;
    }
    if (message.kind === "task.result") return !replied;
    if (message.kind === "user") return false;
  }
  return false;
}

export function createResultTurnReplyPrompt(): UserModelMessage {
  return createFrameworkUserMessage("execution.continuation", RESULT_TURN_REPLY_PROMPT);
}

function hasText(message: Extract<HarnessModelMessage, { readonly role: "assistant" }>): boolean {
  if (typeof message.content === "string") return message.content.trim().length > 0;
  return message.content.some((part) => part.type === "text" && part.text.trim().length > 0);
}
