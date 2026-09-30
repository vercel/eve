import type { ModelMessage } from "ai";
import { commitCallEntry, isTaskTool } from "#execution/tasks/model-step.js";
import {
  createCoordinationRequestFromToolCall,
  resolveToolCallInputObject,
  setPendingCoordinationBatch,
  type CoordinationToolCall,
} from "#harness/coordination.js";
import { hasTailApprovalResponse } from "#harness/current-messages.js";
import type { ResolvedInputBatch } from "#harness/input-request-resolution.js";
import { validateHarnessModelMessages } from "#harness/messages.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";

/**
 * Parks the step on the workflow tools a person just approved. The approval
 * tool message moves into the batch's response so workflow results join it:
 * AI SDK then resumes approved sibling tools without replaying the workflows.
 */
export function dispatchApprovedWorkflowCalls(input: {
  readonly messages: readonly ModelMessage[];
  readonly resolvedInputs: readonly ResolvedInputBatch[] | undefined;
  readonly session: HarnessSession;
  readonly tools: HarnessToolMap;
}): HarnessSession | undefined {
  for (const batch of input.resolvedInputs ?? []) {
    const approved = batch.inputs.filter(
      ({ outcome, request }) =>
        outcome === "approved" &&
        input.tools.get(request.action.toolName)?.workflowId !== undefined,
    );
    if (approved.length === 0) continue;
    if (!hasTailApprovalResponse(input.messages)) {
      throw new Error("Approved workflow calls must follow their approval tool message.");
    }
    const deferred = collectDeferredCalls({
      session: input.session,
      toolCalls: approved.map(({ request }) => ({
        input: request.action.input,
        toolCallId: request.action.callId,
        toolName: request.action.toolName,
      })),
      tools: input.tools,
      turnId: batch.event.turnId,
    });
    return setPendingCoordinationBatch({
      tasks: deferred.workflowRequests,
      event: batch.event,
      responseMessages: input.messages.slice(-1),
      session: {
        ...deferred.session,
        history: validateHarnessModelMessages(input.messages.slice(0, -1)),
      },
    });
  }
  return undefined;
}

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
