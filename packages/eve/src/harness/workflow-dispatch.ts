import { commitCallEntry, isTaskTool } from "#execution/tasks/model-step.js";
import {
  createCoordinationRequestFromToolCall,
  resolveToolCallInputObject,
  type CoordinationToolCall,
} from "#harness/coordination.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";

/**
 * Turns a step's deferred calls into workflow runs, committing a task record
 * for each call that starts a task. Task tool calls stay in the response
 * alone: the session reads them from there.
 */
export function collectDeferredCalls(input: {
  readonly session: HarnessSession;
  readonly toolCalls: readonly CoordinationToolCall[];
  readonly tools: HarnessToolMap;
  readonly turnId: string;
}): {
  readonly session: HarnessSession;
  readonly workflowRequests: readonly RuntimeWorkflowTaskRequest[];
} {
  let { session } = input;
  const workflowRequests: RuntimeWorkflowTaskRequest[] = [];
  for (const toolCall of input.toolCalls) {
    const definition = input.tools.get(toolCall.toolName);
    if (isTaskTool(definition)) continue;
    const committed = commitCallEntry(session, {
      callId: toolCall.toolCallId,
      definition,
      input: resolveToolCallInputObject(toolCall.input, {
        callId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      }),
      toolName: toolCall.toolName,
      turnId: input.turnId,
    });
    session = committed.session;
    workflowRequests.push(
      createCoordinationRequestFromToolCall({
        entry: committed.entry,
        input: committed.input,
        toolCall,
        tools: input.tools,
      }),
    );
  }
  return { session, workflowRequests };
}
