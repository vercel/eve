import type { SessionAuthContext } from "#channel/types.js";
import { createLogger } from "#internal/logging.js";
import {
  createFrameworkUserMessage,
  type HarnessModelMessage,
  type UserModelMessage,
} from "#harness/messages.js";
import { normalizeToolModelOutput } from "#harness/tool-model-output.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import {
  RESULT_TURN_REPLY_PROMPT,
  renderModelOutputBody,
  renderTaskResults,
} from "#tasks/render.js";
import { takeTaskResults, type PendingTaskResult } from "#tasks/results.js";

const log = createLogger("harness.task-results");

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
      body: await projectBody(result, input.tools),
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

/** A definition's `toModelOutput` shapes a completed workflow result, as it does a tool result. */
async function projectBody(
  result: PendingTaskResult,
  tools: HarnessToolMap,
): Promise<string | undefined> {
  if (result.kind !== "workflow" || result.outcome.status !== "completed") return undefined;
  const toModelOutput = tools.get(result.name)?.toModelOutput;
  if (toModelOutput === undefined) return undefined;
  try {
    return renderModelOutputBody(
      normalizeToolModelOutput({
        output: await toModelOutput(result.outcome.output),
        toolName: result.name,
      }),
    );
  } catch (error) {
    log.warn("toModelOutput failed for a task result; delivering the raw output", {
      error,
      taskId: result.taskId,
      toolName: result.name,
    });
    return undefined;
  }
}

function hasText(message: Extract<HarnessModelMessage, { readonly role: "assistant" }>): boolean {
  if (typeof message.content === "string") return message.content.trim().length > 0;
  return message.content.some((part) => part.type === "text" && part.text.trim().length > 0);
}
