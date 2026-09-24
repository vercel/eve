import type { SessionAuthContext } from "#channel/types.js";
import { createFrameworkUserMessage, type UserModelMessage } from "#harness/messages.js";
import { projectTaskResultBody } from "#harness/tool-model-output.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import { renderTaskResults } from "#tasks/render.js";
import { takeTaskResults } from "#tasks/results.js";

/**
 * Takes the held task results of the turn's `principal` and renders them as
 * one `task.result` message. The records are marked delivered in the returned
 * session, so the message and the marks commit together with the step.
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
