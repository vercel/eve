import { stageToolResultMedia } from "#harness/attachment-staging.js";
import type { ModelMessage, ToolSet, TypedToolCall, TypedToolError } from "ai";

import type { CompactionConfig, StepResult } from "#harness/types.js";
import { FINAL_OUTPUT_BESIDE_PENDING_CALLS } from "#harness/final-output.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import {
  type HarnessModelMessage,
  resolveAssistantStepText,
  validateHarnessModelMessages,
} from "#harness/messages.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import {
  appendMissingToolResultMessages,
  extractToolResultCallIds,
} from "#harness/model-call/response.js";
import type { ModelResponse } from "#harness/model-call/run.js";
import type { EndsTurnTools } from "#harness/model-call/tools.js";
import type { JsonValue } from "#shared/json.js";
import type { Step } from "#harness/step/context.js";
import {
  fail,
  finishTurn,
  hold,
  suspendStep,
  type ToolResultPart,
  withResult,
} from "#harness/session-machine/transitions.js";
import { clearTurnClientContextState } from "#harness/turn-client-context.js";
import { collectWorkflowCalls } from "#harness/coordination.js";
import {
  createToolResultMessagePartFromToolError,
  isToolResultError,
} from "#harness/action-result-helpers.js";
import {
  extractToolApprovalInputRequests,
  hasRunnableQueue,
  parkOnApprovals,
  stopForToolSignIn,
} from "#harness/hitl/index.js";
import {
  getInvalidToolCallInputError,
  isInvalidToolCall,
} from "#harness/tool-call-input-errors.js";
import { isWorkflowTool, workingTaskIds } from "#execution/tasks/model-step.js";
import { normalizeProviderToolHistory } from "#harness/provider-tool-history.js";
import { renderFinalOutputWhileWorkingError } from "#execution/tasks/render.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { setRequestEnvelopeTokens } from "#harness/request-envelope.js";
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
  // Unions every invalid-input signal: SDK-marked invalid calls (which get
  // SDK-synthesized tool errors), non-object inputs caught by
  // getInvalidToolCallInputErrors, and ids the stream consumer observed.
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
  // eve runs approved calls itself, so the SDK's approval parts never reach history.
  const responseMessages = await stageToolResultMedia(
    withoutApprovalParts(normalizedProviderHistory.messages),
  );

  step.session = setRequestEnvelopeTokens(
    {
      ...step.session,
      compaction: createNextCompactionConfig(
        step.session.compaction,
        input.durableModelPromptMessageCount,
        result,
      ),
    },
    result.usage?.inputTokens !== undefined && input.durableModelPromptMessageCount !== undefined
      ? input.requestEnvelopeTokens
      : undefined,
  );

  const approvalRequests = extractToolApprovalInputRequests({
    content: result.content ?? [],
    excludedCallIds: invalidInputToolCallIds,
    tools: input.catalog,
  });
  // Only unanswered calls can dispatch: automatic denials already have results.
  const blockedCallIds = new Set([
    ...approvalRequests.map((request) => request.action.callId),
    ...extractToolResultCallIds(responseMessages),
  ]);
  const workflowToolCalls = ((result.toolCalls ?? []) as TypedToolCall<ToolSet>[])
    .filter((toolCall) => !invalidInputToolCallIds.has(toolCall.toolCallId))
    .filter((toolCall) => !blockedCallIds.has(toolCall.toolCallId))
    .filter((toolCall) => isWorkflowTool(input.catalog.get(toolCall.toolName)));

  const authorizationInterrupt = resolveInlineAuthorizationInterrupt({
    messages: [...promptMessages, ...responseMessages],
    toolResults: result.toolResults,
  });

  // --- Park on approvals or runtime calls ----------------------------------

  if (workflowToolCalls.length > 0 || approvalRequests.length > 0) {
    const { sequence, stepIndex, turnId } = step.position();
    const dispatched = collectWorkflowCalls({
      session: step.session,
      toolCalls: workflowToolCalls,
      tools: input.catalog,
      turnId,
    });
    step.session = { ...dispatched.session, history: validateHarnessModelMessages(promptMessages) };
    const parked = {
      event: { sequence, stepIndex, turnId },
      // A suspended response commits once every call it made has a result, so a call that will
      // never get one is answered now.
      messages: answerCallsThatWontRun(responseMessages, result),
      tasks: dispatched.workflowRequests,
    };
    if (approvalRequests.length > 0) {
      const parkedResult = await parkOnApprovals(step, {
        ...parked,
        requests: approvalRequests,
        tools: input.catalog,
        waitsOnRuntime: workflowToolCalls.length > 0 || authorizationInterrupt !== undefined,
      });
      // Approval only precedes sign-in for the same call, not an executing sibling.
      if (authorizationInterrupt) {
        return stopForToolSignIn(step, {
          ...authorizationInterrupt,
          history: step.session.history,
        });
      }
      return parkedResult;
    }
    await step.apply(suspendStep(step.view(), parked));
    if (authorizationInterrupt) {
      return stopForToolSignIn(step, {
        ...authorizationInterrupt,
        history: step.session.history,
      });
    }
    if (dispatched.workflowRequests.length > 0) {
      await step.apply(hold(step.view(), { on: "tasks" }));
    }
    return { next: null, session: step.session };
  }

  // --- Park on authorization request ------------------------------------------

  if (authorizationInterrupt) return stopForToolSignIn(step, authorizationInterrupt);

  // --- Continue or terminate ------------------------------------------------

  // History grows by append only; nothing rewrites earlier messages mid-turn,
  // so the prompt prefix stays stable and the provider's prompt cache keeps
  // hitting across steps. Compaction is the sole mechanism that ever rewrites
  // history, and it runs before the model call (see `maybeCompact`).
  step.session = {
    ...step.session,
    history: validateHarnessModelMessages([...promptMessages, ...responseMessages]),
  };

  // An `eve__reply` call is terminal even when the model emits it alongside
  // executing tools: continuing the loop would leave the no-execute call as a
  // dangling tool_use the next provider call rejects, and drop the result.
  const calledFinalOutput =
    step.session.outputSchema !== undefined && extractFinalOutput(result) !== undefined;
  const workingTasks = workingTaskIds(step.session);
  const finalOutputRejected = calledFinalOutput && workingTasks.length > 0;
  let responseTail: readonly ModelMessage[] = responseMessages;
  if (finalOutputRejected) {
    responseTail = rejectFinalOutput(responseMessages, result, workingTasks);
    step.session = {
      ...step.session,
      history: validateHarnessModelMessages([...promptMessages, ...responseTail]),
    };
  }

  const endsTurn = await stepEndsTurn(result, responseMessages, input.endsTurnTools);
  const continueLoop =
    (!calledFinalOutput || finalOutputRejected) &&
    ((responseTail.at(-1)?.role === "tool" && !endsTurn) ||
      normalizedProviderHistory.outcomeEndsResponse ||
      hasRunnableQueue(step.view()));
  if (continueLoop) return { next: step.runStep, session: step.session };
  // The turn rule: no turn ends while its tasks work. The session waits for
  // one to settle, then calls the model again in the same turn.
  if (workingTasks.length > 0) {
    await step.apply(hold(step.view(), { on: "tasks" }));
    return { held: { kind: "tasks", taskIds: workingTasks }, next: null, session: step.session };
  }

  return settleTurn(step, {
    history: promptMessages,
    result,
    // Text written before an `endsTurn` call was narration, not the reply.
    stepOutput: endsTurn ? null : stepOutput,
  });
}

/**
 * Answers the calls of a response that waits on others which will never get a result: a
 * `eve__reply` written before the results it waits beside.
 */
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

/** The SDK's approval parts: eve answers approvals itself, so history never holds them. */
export function withoutApprovalParts(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role !== "assistant" && message.role !== "tool") return [message];
    if (!Array.isArray(message.content)) return [message];
    const content = message.content.filter(
      (part) => part.type !== "tool-approval-request" && part.type !== "tool-approval-response",
    );
    return content.length === 0 ? [] : [{ ...message, content } as ModelMessage];
  });
}

/**
 * Whether the step ends the turn: every tool call targets a tool that can end
 * the turn and succeeded, and each `endsTurn` function accepts its call's
 * `execute` output. A failed or invalid call lets the model recover instead.
 */
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
  const succeeded = toolCalls.every((toolCall) => {
    const output = outputs.get(toolCall.toolCallId);
    return (
      endsTurnTools.has(toolCall.toolName) && output !== undefined && !isToolResultError(output)
    );
  });
  if (!succeeded) return false;
  const executeOutputs = new Map(
    (result.toolResults ?? []).map((toolResult) => [toolResult.toolCallId, toolResult.output]),
  );
  for (const toolCall of toolCalls) {
    const endsTurn = endsTurnTools.get(toolCall.toolName);
    if (typeof endsTurn !== "function") continue;
    if (!(await callEndsTurn(endsTurn, executeOutputs.get(toolCall.toolCallId), toolCall))) {
      return false;
    }
  }
  return true;
}

/** A throwing `endsTurn` function keeps the turn going rather than failing it. */
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

/** Answers an `eve__reply` call made while tasks work with an error naming them. */
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

/**
 * The structured value the model delivered by calling the framework
 * `eve__reply` tool, or `undefined` when the terminal turn ended in prose.
 */
function extractFinalOutput(result: HarnessStepResult): JsonValue | undefined {
  return (result.toolCalls ?? []).find(
    (call) => call.toolName === REPLY_TOOL_NAME && !isInvalidToolCall(call),
  )?.input as JsonValue | undefined;
}

/**
 * Closes a terminal turn. An unmet output schema fails the turn recoverably;
 * otherwise the structured value (or prose) ends the turn and the session
 * waits for the next message. The structured value replaces the un-executed
 * `eve__reply` call, which would be a dangling tool_use on the next turn,
 * and the schema, scoped to the turn, clears.
 */
async function settleTurn(
  step: Step,
  input: {
    readonly history: readonly HarnessModelMessage[];
    readonly result: HarnessStepResult;
    readonly stepOutput: string | null;
  },
): Promise<StepResult> {
  const { history, result, stepOutput } = input;
  const schema = step.session.outputSchema;
  step.session = clearTurnClientContextState(step.session);

  if (schema === undefined) {
    await step.apply(finishTurn(step.view()), step.session.history);
    return { next: null, session: step.session, settledTurn: { output: stepOutput ?? "" } };
  }

  const structured = extractFinalOutput(result);
  // The schema belongs to the settled turn. A later conversation turn that
  // omits outputSchema must not inherit its contract.
  if (structured === undefined) {
    step.session = { ...step.session, outputSchema: undefined };
    await step.apply(fail(step.view(), OUTPUT_SCHEMA_NOT_FULFILLED));
    return {
      next: null,
      session: step.session,
      settledTurn: { isError: true, output: OUTPUT_SCHEMA_NOT_FULFILLED.message },
    };
  }

  step.session = {
    ...step.session,
    history: [...history, { content: JSON.stringify(structured), role: "assistant" }],
    outputSchema: undefined,
  };
  await step.apply(finishTurn(step.view(), { result: structured }), step.session.history);
  return { next: null, session: step.session, settledTurn: { output: structured } };
}

function createNextCompactionConfig(
  current: CompactionConfig,
  durablePromptMessageCount: number | undefined,
  result: HarnessStepResult,
): CompactionConfig {
  const next: {
    lastKnownInputTokens?: number;
    lastKnownPromptMessageCount?: number;
    recentWindowSize: number;
    threshold: number;
    thresholdPercent?: number;
  } = {
    recentWindowSize: current.recentWindowSize,
    threshold: current.threshold,
    thresholdPercent: current.thresholdPercent,
  };

  if (result.usage?.inputTokens !== undefined && durablePromptMessageCount !== undefined) {
    next.lastKnownInputTokens = result.usage.inputTokens;
    next.lastKnownPromptMessageCount = durablePromptMessageCount;
  }

  return next;
}
