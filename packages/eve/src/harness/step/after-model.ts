import { changeHistory } from "#harness/session-machine/history.js";
import { stageToolResultMedia } from "#harness/attachment-staging.js";
import type { ModelMessage, ToolSet, TypedToolCall, TypedToolError } from "ai";

import type { StepResult } from "#harness/types.js";
import { FINAL_OUTPUT_BESIDE_PENDING_CALLS } from "#harness/final-output.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { createFrameworkUserMessage, resolveAssistantStepText } from "#harness/messages.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import {
  appendMissingToolResultMessages,
  extractToolResultCallIds,
} from "#harness/model-call/response.js";
import type { ModelResponse } from "#harness/model-call/run.js";
import type { EndsTurnTools } from "#harness/model-call/tools.js";
import type { JsonValue } from "#shared/json.js";
import { failTurnForEffect, type Step, stepReference } from "#harness/step/context.js";
import { complete, fail, suspendStep } from "#harness/session-machine/transitions.js";
import { type ToolResultPart, withResult } from "#harness/session-machine/suspended-steps.js";
import { clearTurnClientContextState } from "#harness/turn-client-context.js";
import { collectPromotedTasks, collectWorkflowCalls } from "#harness/coordination.js";
import {
  createToolResultMessagePartFromToolError,
  isToolResultError,
} from "#harness/action-result-helpers.js";
import { askStepApprovals, stopForSignIn } from "#harness/hitl/index.js";
import { hasQueuedTurnInput, park } from "#harness/step/park.js";
import {
  getInvalidToolCallInputError,
  isInvalidToolCall,
} from "#harness/tool-call-input-errors.js";
import { DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS } from "#execution/dynamic-workflow/schema.js";
import { isWorkflowTool, workingTaskIds } from "#execution/tasks/model-step.js";
import { isProgramTool } from "#harness/program-calls.js";
import { newProgram, savePrograms } from "#harness/session-machine/programs.js";
import { normalizeProviderToolHistory } from "#harness/provider-tool-history.js";
import { renderFinalOutputWhileWorkingError } from "#execution/tasks/render.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { withPromptMeasurement } from "#harness/compaction/engine.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("harness.tool-loop");

function getInvalidToolCallInputErrors(input: {
  readonly toolCalls: readonly TypedToolCall<ToolSet>[];
}): readonly TypedToolError<ToolSet>[] {
  const errors: TypedToolError<ToolSet>[] = [];

  for (const toolCall of input.toolCalls) {
    if (toolCall.toolName === REPLY_TOOL_NAME) {
      continue;
    }

    const toolError = getInvalidToolCallInputError({ toolCall });
    if (toolError !== undefined) {
      errors.push(toolError);
    }
  }

  return errors;
}

export async function handleStepResult(step: Step, input: ModelResponse): Promise<StepResult> {
  const { promptMessages, result } = input;

  const stepOutput = resolveAssistantStepText(result.response.messages, result.text);
  const invalidInputToolErrors = getInvalidToolCallInputErrors({
    toolCalls: result.toolCalls as TypedToolCall<ToolSet>[],
  });
  const invalidInputToolCallIds = new Set([
    ...(result.invalidInputToolCallIds ?? []),
    ...result.toolCalls.filter(isInvalidToolCall).map((toolCall) => toolCall.toolCallId),
    ...invalidInputToolErrors.map((toolError) => toolError.toolCallId),
  ]);
  const rawResponseMessages = appendMissingToolResultMessages({
    append: invalidInputToolErrors.map((toolError) =>
      createToolResultMessagePartFromToolError(toolError),
    ),
    responseMessages: result.response.messages,
  });

  const providerExecutedOutcomeIds = new Set<string>();
  for (const part of [...(result.content ?? []), ...(result.toolResults ?? [])]) {
    if (
      (part.type === "tool-result" || part.type === "tool-error") &&
      part.providerExecuted === true
    ) {
      providerExecutedOutcomeIds.add(part.toolCallId);
    }
  }
  const normalizedProviderHistory = normalizeProviderToolHistory({
    messages: rawResponseMessages,
    providerExecutedOutcomeIds,
  });
  const responseMessages = await stageToolResultMedia(normalizedProviderHistory.messages);

  step.session = {
    ...step.session,
    compaction: withPromptMeasurement(step.session.compaction, {
      promptMessages,
      inputTokens: result.usage?.inputTokens,
      modelId: stepReference(step).id,
      promptMessageCount: input.durableModelPromptMessageCount,
      requestEnvelopeTokens: input.requestEnvelopeTokens,
    }),
  };

  const approvalRequests = result.approvalRequests ?? [];
  const promotedTasks = result.promotedTasks ?? [];
  const blockedCallIds = new Set([
    ...approvalRequests.map((ask) => ask.call.callId),
    ...promotedTasks.map((promoted) => promoted.callId),
    ...extractToolResultCallIds(responseMessages),
  ]);
  const workflowToolCalls = ((result.toolCalls ?? []) as TypedToolCall<ToolSet>[])
    .filter((toolCall) => !invalidInputToolCallIds.has(toolCall.toolCallId))
    .filter((toolCall) => !blockedCallIds.has(toolCall.toolCallId))
    .filter((toolCall) => {
      const definition = input.catalog.get(toolCall.toolName);
      return isWorkflowTool(definition) && !isProgramTool(definition);
    });
  const programCalls = ((result.toolCalls ?? []) as TypedToolCall<ToolSet>[])
    .filter((toolCall) => !invalidInputToolCallIds.has(toolCall.toolCallId))
    .filter((toolCall) => !blockedCallIds.has(toolCall.toolCallId))
    .filter((toolCall) => isProgramTool(input.catalog.get(toolCall.toolName)));

  const authorizationInterrupt = resolveInlineAuthorizationInterrupt({
    signIns: result.signIns ?? [],
  });

  if (
    workflowToolCalls.length > 0 ||
    promotedTasks.length > 0 ||
    programCalls.length > 0 ||
    approvalRequests.length > 0 ||
    authorizationInterrupt
  ) {
    const { sequence, stepIndex, turnId } = step.position();
    const dispatched = collectWorkflowCalls({
      clearances: result.policyApprovals ?? {},
      session: step.session,
      toolCalls: workflowToolCalls,
      tools: input.catalog,
      turnId,
    });
    const promoted = collectPromotedTasks({
      promotedTasks,
      session: dispatched.session,
      turnId,
    });
    step.session = changeHistory(promoted.session, { extend: promptMessages });
    const endsTurn =
      !normalizedProviderHistory.outcomeEndsResponse &&
      (await stepEndsTurn(result, responseMessages, input.endsTurnTools));
    const parked = {
      ...(endsTurn && { endsTurn: true as const }),
      event: { sequence, stepIndex, turnId },
      messages: answerCallsThatWontRun(responseMessages, result),
      tasks: [...dispatched.workflowRequests, ...promoted.workflowRequests],
    };
    if (approvalRequests.length > 0) {
      await askStepApprovals(step, { ...parked, requests: approvalRequests, tools: input.catalog });
    } else {
      await step.apply(suspendStep(step.view(), parked));
    }
    if (programCalls.length > 0) {
      const programs = programCalls.map((toolCall) => {
        const definition = input.catalog.get(toolCall.toolName);
        return newProgram(
          toolCall.toolCallId,
          toolCall.toolName,
          toolCall.input,
          { sequence, stepIndex, turnId },
          definition?.workflowProgram?.maxSubagents ?? DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
        );
      });
      await step.apply(savePrograms(step.view(), programs));
    }
    if (authorizationInterrupt) return stopForSignIn(step, authorizationInterrupt);
    return park(step);
  }

  const finalOutput =
    step.session.outputSchema === undefined ? undefined : extractFinalOutput(result);
  const calledFinalOutput = finalOutput !== undefined;
  const workingTasks = workingTaskIds(step.session);
  const finalOutputRejected = calledFinalOutput && workingTasks.length > 0;
  const responseTail: readonly ModelMessage[] = finalOutputRejected
    ? rejectFinalOutput(responseMessages, result, workingTasks)
    : responseMessages;
  const historyTail: readonly ModelMessage[] =
    calledFinalOutput && !finalOutputRejected
      ? [{ content: JSON.stringify(finalOutput), role: "assistant" }]
      : responseTail;
  step.session = changeHistory(step.session, { extend: [...promptMessages, ...historyTail] });

  const delivered = calledFinalOutput && !finalOutputRejected;
  const endsTurn = await stepEndsTurn(result, responseMessages, input.endsTurnTools);
  const continueLoop =
    !delivered &&
    ((responseTail.at(-1)?.role === "tool" && !endsTurn) ||
      normalizedProviderHistory.outcomeEndsResponse ||
      hasQueuedTurnInput(step.view()));
  if (continueLoop) return { next: step.runStep, session: step.session };
  if (workingTasks.length > 0) {
    return { held: { kind: "tasks", taskIds: workingTasks }, next: null, session: step.session };
  }
  if (
    !delivered &&
    !endsTurn &&
    result.finishReason === "length" &&
    countTrailingLengthContinuations(step.session.history) < MAX_LENGTH_CONTINUATIONS
  ) {
    step.session = changeHistory(step.session, {
      extend: [
        ...step.session.history,
        createFrameworkUserMessage("execution.retry", LENGTH_CONTINUATION_PROMPT),
      ],
    });
    return { next: step.runStep, session: step.session };
  }
  return settleTurn(step, { result, stepOutput: endsTurn ? null : stepOutput });
}

const MAX_LENGTH_CONTINUATIONS = 3;

const LENGTH_CONTINUATION_PROMPT =
  "Your previous response reached the output length limit before finishing. Continue directly from where it stopped and take the next tool call or complete your reply. Do not repeat completed work and do not mention this notice.";

function countTrailingLengthContinuations(history: readonly ModelMessage[]): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message?.role === "assistant") continue;
    if (message?.role === "user" && message.content === LENGTH_CONTINUATION_PROMPT) {
      count++;
      continue;
    }
    break;
  }
  return count;
}

function answerCallsThatWontRun(
  messages: readonly ModelMessage[],
  result: HarnessStepResult,
): ModelMessage[] {
  const answered = extractToolResultCallIds(messages);
  const finalOutputs = ((result.toolCalls ?? []) as TypedToolCall<ToolSet>[]).filter(
    (call) => call.toolName === REPLY_TOOL_NAME,
  );
  const answers: ToolResultPart[] = finalOutputs.map((call) => ({
    output: { type: "error-text" as const, value: FINAL_OUTPUT_BESIDE_PENDING_CALLS },
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    type: "tool-result" as const,
  }));
  return answers
    .filter((part) => !answered.has(part.toolCallId))
    .reduce<ModelMessage[]>((next, part) => withResult(next, part), [...messages]);
}

async function stepEndsTurn(
  result: HarnessStepResult,
  responseMessages: readonly ModelMessage[],
  endsTurnTools: EndsTurnTools,
): Promise<boolean> {
  const toolCalls = result.toolCalls ?? [];
  if (toolCalls.length === 0) return false;
  const outputs = new Map<string, ToolResultPart["output"]>();
  for (const message of responseMessages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") outputs.set(part.toolCallId, part.output);
    }
  }
  const executeOutputs = new Map(
    (result.toolResults ?? []).map((toolResult) => [toolResult.toolCallId, toolResult.output]),
  );
  return await callsEndTurn(
    toolCalls.map((toolCall) => {
      const output = outputs.get(toolCall.toolCallId);
      return {
        failed: output === undefined || isToolResultError(output),
        output: executeOutputs.get(toolCall.toolCallId),
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      };
    }),
    endsTurnTools,
  );
}

export interface EndingCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly failed: boolean;
  readonly output: unknown;
}

export async function callsEndTurn(
  calls: readonly EndingCall[],
  endsTurnTools: EndsTurnTools,
): Promise<boolean> {
  let ends = false;
  for (const call of calls) {
    const endsTurn = endsTurnTools.get(call.toolName);
    if (endsTurn === undefined || call.failed) continue;
    if (typeof endsTurn !== "function" || (await callEndsTurn(endsTurn, call.output, call))) {
      ends = true;
    }
  }
  return ends;
}

async function callEndsTurn(
  endsTurn: (output: unknown) => boolean | Promise<boolean>,
  output: unknown,
  toolCall: { readonly toolCallId: string; readonly toolName: string },
): Promise<boolean> {
  try {
    return (await endsTurn(output)) === true;
  } catch (error) {
    log.warn("endsTurn threw; continuing the turn", {
      callId: toolCall.toolCallId,
      error,
      toolName: toolCall.toolName,
    });
    return false;
  }
}

function rejectFinalOutput(
  responseMessages: readonly ModelMessage[],
  result: HarnessStepResult,
  workingTasks: readonly string[],
): ModelMessage[] {
  const call = (result.toolCalls ?? []).find((toolCall) => toolCall.toolName === REPLY_TOOL_NAME);
  if (call === undefined) return [...responseMessages];
  const rejection: ToolResultPart = {
    output: { type: "error-text", value: renderFinalOutputWhileWorkingError(workingTasks) },
    toolCallId: call.toolCallId,
    toolName: REPLY_TOOL_NAME,
    type: "tool-result",
  };
  return [...responseMessages, { content: [rejection], role: "tool" }];
}

const OUTPUT_SCHEMA_NOT_FULFILLED = {
  code: "OUTPUT_SCHEMA_NOT_FULFILLED",
  message: "The agent could not produce a result matching the requested schema.",
} as const;

function extractFinalOutput(result: HarnessStepResult): JsonValue | undefined {
  return (result.toolCalls ?? []).find(
    (call) => call.toolName === REPLY_TOOL_NAME && !isInvalidToolCall(call),
  )?.input as JsonValue | undefined;
}

export async function settleTurn(
  step: Step,
  input: {
    readonly result?: HarnessStepResult;
    readonly stepOutput: string | null;
  },
): Promise<StepResult> {
  const { result, stepOutput } = input;
  const hookFailure = await failTurnForEffect(step);
  if (hookFailure !== undefined) return hookFailure;
  const schema = step.session.outputSchema;
  step.session = clearTurnClientContextState(step.session);

  if (schema === undefined) {
    await step.apply(complete(step.view()), step.session.history);
    return { next: null, session: step.session, settledTurn: { output: stepOutput ?? "" } };
  }

  const structured = result === undefined ? undefined : extractFinalOutput(result);
  if (structured === undefined) {
    step.session = { ...step.session, outputSchema: undefined };
    await step.apply(fail(step.view(), OUTPUT_SCHEMA_NOT_FULFILLED));
    return {
      next: null,
      session: step.session,
      settledTurn: { isError: true, output: OUTPUT_SCHEMA_NOT_FULFILLED.message },
    };
  }

  step.session = { ...step.session, outputSchema: undefined };
  await step.apply(complete(step.view()), step.session.history);
  return { next: null, session: step.session, settledTurn: { output: structured } };
}
