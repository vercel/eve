import type { ModelMessage, ToolSet, TypedToolCall, TypedToolError } from "ai";

import { isTaskTool, workingTaskIds } from "#execution/tasks/model-step.js";
import { renderFinalOutputWhileWorkingError } from "#execution/tasks/render.js";
import {
  createToolResultMessagePartFromToolError,
  isToolResultError,
} from "#harness/action-result-helpers.js";
import { getAdvertisedTools } from "#harness/advertised-tools.js";
import { setPendingCoordinationBatch } from "#harness/coordination.js";
import {
  advanceStep,
  emitRecoverableFailedTurn,
  emitTurnEpilogue,
  type HarnessEmissionState,
} from "#harness/emission.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  appendMissingToolResultMessages,
  extractToolResultCallIds,
} from "#harness/model-call/response.js";
import type { ModelResponse } from "#harness/model-call/run.js";
import type { EndsTurnTools } from "#harness/model-call/tools.js";
import { FINAL_OUTPUT_TOOL_NAME } from "#harness/final-output.js";
import {
  extractToolApprovalInputRequests,
  hasRunnableDeferredStepInput,
  parkOnApprovals,
  stopForToolSignIn,
} from "#harness/human-input/index.js";
import {
  type HarnessModelMessage,
  resolveAssistantStepText,
  validateHarnessModelMessages,
} from "#harness/messages.js";
import { normalizeProviderToolHistory } from "#harness/provider-tool-history.js";
import { setRequestEnvelopeTokens } from "#harness/request-envelope.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import {
  getInvalidToolCallInputError,
  isInvalidToolCall,
} from "#harness/tool-call-input-errors.js";
import { clearTurnClientContextState } from "#harness/turn-client-context.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import type { CompactionConfig, StepResult } from "#harness/types.js";
import { collectDeferredCalls } from "#harness/workflow-dispatch.js";
import { createLogger } from "#internal/logging.js";
import { createResultCompletedEvent, createTurnWaitingEvent } from "#protocol/message.js";
import type { JsonValue } from "#shared/json.js";
import type { Step } from "./context.js";

const log = createLogger("harness.tool-loop");

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

/**
 * What the session does with a model step's response: parks it on the calls a person must approve
 * or the runtime must run, stops for a sign-in, calls the model again, holds the turn while its
 * tasks work, or ends the turn.
 */
export async function handleStepResult(step: Step, input: ModelResponse): Promise<StepResult> {
  const { promptMessages, result } = input;
  const position: HarnessEmissionState = input.outputStarted
    ? { ...step.position(), assistantOutputStarted: true }
    : step.position();

  const stepOutput = resolveAssistantStepText(result.response.messages, result.text);
  const invalidInputToolErrors = getInvalidToolCallInputErrors(
    result.toolCalls as TypedToolCall<ToolSet>[],
  );
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
  const responseMessages = normalizedProviderHistory.messages;

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
  });
  const advertisedCoordinationTools = getAdvertisedTools({
    session: step.session,
    tools: input.coordinationTools,
  });
  // Only unanswered calls can dispatch: automatic denials already have results.
  const blockedCallIds = new Set([
    ...approvalRequests.map((request) => request.action.callId),
    ...extractToolResultCallIds(responseMessages),
  ]);
  const deferredToolCalls = ((result.toolCalls ?? []) as TypedToolCall<ToolSet>[])
    .filter((toolCall) => !invalidInputToolCallIds.has(toolCall.toolCallId))
    .filter((toolCall) => !blockedCallIds.has(toolCall.toolCallId))
    .filter((toolCall) => isDeferredHarnessTool(input.coordinationTools.get(toolCall.toolName)))
    .filter((toolCall) => {
      if (isDeferredHarnessTool(advertisedCoordinationTools.get(toolCall.toolName))) {
        return true;
      }
      log.warn("deferred tool call blocked because tool is not advertised", {
        callId: toolCall.toolCallId,
        sessionId: step.session.sessionId,
        toolName: toolCall.toolName,
      });
      return false;
    });

  // --- Park on approvals or runtime calls ----------------------------------

  if (deferredToolCalls.length > 0 || approvalRequests.length > 0) {
    const deferred = collectDeferredCalls({
      session: step.session,
      toolCalls: deferredToolCalls,
      tools: advertisedCoordinationTools,
      turnId: position.turnId,
    });
    step.session = deferred.session;
    const runtimeCalls = deferredToolCalls.length > 0 ? deferred.workflowRequests : undefined;
    if (approvalRequests.length > 0) {
      return parkOnApprovals(step, {
        position,
        promptMessages,
        requests: approvalRequests,
        responseMessages,
        runtimeCalls,
      });
    }
    step.session = setPendingCoordinationBatch({
      event: {
        sequence: position.sequence,
        stepIndex: position.stepIndex,
        turnId: position.turnId,
      },
      responseMessages,
      session: { ...step.session, history: validateHarnessModelMessages(promptMessages) },
      tasks: deferred.workflowRequests,
    });
    step.moveTo(advanceStep(position));
    return { next: null, session: step.session };
  }

  // --- Park on authorization request ------------------------------------------

  const signIn = await stopForToolSignIn(step, {
    messages: [...promptMessages, ...responseMessages],
    position,
    toolResults: result.toolResults,
  });
  if (signIn !== undefined) return signIn;

  // --- Continue or terminate ------------------------------------------------

  // History grows by append only; nothing rewrites earlier messages mid-turn,
  // so the prompt prefix stays stable and the provider's prompt cache keeps
  // hitting across steps. Compaction is the sole mechanism that ever rewrites
  // history, and it runs before the model call (see `maybeCompact`).
  step.session = {
    ...step.session,
    history: validateHarnessModelMessages([...promptMessages, ...responseMessages]),
  };

  // A `final_output` call is terminal even when the model emits it alongside
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
      hasRunnableDeferredStepInput(step.session));
  const holdsTurn = !continueLoop && workingTasks.length > 0;
  if (continueLoop || holdsTurn) {
    const next = advanceStep(position);
    if (step.emit) step.moveTo(next);
    if (!holdsTurn) return { next: step.runStep, session: step.session };
    // The turn rule: no turn ends while its tasks work. The session waits for
    // one to settle, then calls the model again in the same turn. The turn
    // stays open, so it parks with `turn.waiting` rather than completing.
    await step.emit?.(
      createTurnWaitingEvent({
        on: "tasks",
        sequence: next.sequence,
        turnId: next.turnId,
        usage: getSessionUsage(step.session),
      }),
    );
    return { held: { kind: "tasks", taskIds: workingTasks }, next: null, session: step.session };
  }

  return settleTurn(step, {
    history: promptMessages,
    position,
    result,
    // Text written before an `endsTurn` call was narration, not the reply.
    stepOutput: endsTurn ? null : stepOutput,
  });
}

function getInvalidToolCallInputErrors(
  toolCalls: readonly TypedToolCall<ToolSet>[],
): readonly TypedToolError<ToolSet>[] {
  return toolCalls.flatMap((toolCall) => {
    if (toolCall.toolName === FINAL_OUTPUT_TOOL_NAME) return [];
    const toolError = getInvalidToolCallInputError({ toolCall });
    return toolError === undefined ? [] : [toolError];
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

function isDeferredHarnessTool(tool: HarnessToolDefinition | undefined): boolean {
  return tool?.workflowId !== undefined || isTaskTool(tool);
}

/** Answers a `final_output` call made while tasks work with an error naming them. */
function rejectFinalOutput(
  responseMessages: readonly ModelMessage[],
  result: HarnessStepResult,
  workingTasks: readonly string[],
): ModelMessage[] {
  const call = (result.toolCalls ?? []).find(
    (toolCall) => toolCall.toolName === FINAL_OUTPUT_TOOL_NAME,
  );
  if (call === undefined) return [...responseMessages];
  const rejection: ToolResultPart = {
    output: { type: "error-text", value: renderFinalOutputWhileWorkingError(workingTasks) },
    toolCallId: call.toolCallId,
    toolName: FINAL_OUTPUT_TOOL_NAME,
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
 * `final_output` tool, or `undefined` when the terminal turn ended in prose.
 */
function extractFinalOutput(result: HarnessStepResult): JsonValue | undefined {
  return (result.toolCalls ?? []).find(
    (call) => call.toolName === FINAL_OUTPUT_TOOL_NAME && !isInvalidToolCall(call),
  )?.input as JsonValue | undefined;
}

/**
 * Closes a terminal turn. An unmet output schema fails the turn recoverably;
 * otherwise the structured value (or prose) ends the turn and the session
 * waits for the next message. The structured value replaces the un-executed
 * `final_output` call, which would be a dangling tool_use on the next turn,
 * and the schema, scoped to the turn, clears.
 */
async function settleTurn(
  step: Step,
  input: {
    readonly history: readonly HarnessModelMessage[];
    readonly position: HarnessEmissionState;
    readonly result: HarnessStepResult;
    readonly stepOutput: string | null;
  },
): Promise<StepResult> {
  const { emit } = step;
  const { history, position, result, stepOutput } = input;
  const schema = step.session.outputSchema;
  step.session = clearTurnClientContextState(step.session);

  if (schema === undefined) {
    if (emit) {
      const usage = getSessionUsage(step.session);
      step.moveTo(await emitTurnEpilogue(emit, position, step.session.history, usage));
    }
    return { next: null, session: step.session, settledTurn: { output: stepOutput ?? "" } };
  }

  const structured = extractFinalOutput(result);
  // The schema belongs to the settled turn. A later conversation turn that
  // omits outputSchema must not inherit its contract.
  if (structured === undefined) {
    step.session = { ...step.session, outputSchema: undefined };
    if (emit) {
      step.moveTo(
        await emitRecoverableFailedTurn(emit, position, {
          ...OUTPUT_SCHEMA_NOT_FULFILLED,
          continuationToken: step.session.continuationToken,
          usage: getSessionUsage(step.session),
        }),
      );
    }
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
  if (emit) {
    await emit(
      createResultCompletedEvent({
        result: structured,
        sequence: position.sequence,
        stepIndex: position.stepIndex,
        turnId: position.turnId,
      }),
    );
    const usage = getSessionUsage(step.session);
    step.moveTo(await emitTurnEpilogue(emit, position, step.session.history, usage));
  }
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
