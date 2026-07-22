import type { ModelMessage, ToolSet, TypedToolCall, TypedToolResult } from "ai";
import { contextStorage } from "#context/container.js";
import type { LoopTypes, TurnStepResult } from "#core/types.js";
import { createToolResultMessagePartFromToolError } from "#harness/action-result-helpers.js";
import { getAdvertisedTools } from "#harness/advertised-tools.js";
import {
  type AuthorizationSignal,
  getPendingAuthorization,
  isAuthorizationSignal,
  setPendingAuthorization,
} from "#harness/authorization.js";
import { createNextCompactionConfig } from "#harness/compaction.js";
import {
  advanceStep,
  emitTurnEpilogue,
  getHarnessEmissionState,
  setHarnessEmissionState,
} from "#harness/emission.js";
import {
  extractQuestionInputRequests,
  extractToolApprovalInputRequests,
} from "#harness/input-extraction.js";
import {
  hasDeferredStepInput,
  hasPendingInputBatch,
  setPendingInputBatch,
} from "#harness/input-requests.js";
import { resolveAssistantStepText } from "#harness/messages.js";
import {
  appendMissingToolResultMessages,
  getInvalidToolCallInputErrors,
} from "#harness/model-call-recovery.js";
import { normalizeProviderToolHistory } from "#harness/provider-tool-history.js";
import {
  createRuntimeActionRequestFromToolCall,
  getPendingRuntimeActionBatch,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import { isInvalidToolCall } from "#harness/tool-call-input-errors.js";
import { readToolInterrupt } from "#harness/tool-interrupts.js";
import { finishConversationTurn, finishTaskTurn } from "#harness/turn-finish.js";
import type {
  GenerateOutcome,
  HarnessLoopTypes,
  HarnessSession,
  HarnessToolMap,
  GenerateConfig,
} from "#harness/types.js";
import { readWorkflowContinuationSecurity } from "#harness/workflow-continuation-security.js";
import { parkOnWorkflowInterrupt } from "#harness/workflow-interrupt-continuation.js";
import { getPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import {
  getRuntimeActionKeysFromWorkflowInterrupt,
  isWorkflowRuntimeActionInterrupt,
} from "#harness/workflow-runtime-action-state.js";
import { createLogger } from "#internal/logging.js";
import { createAuthorizationRequiredEvent, createInputRequestedEvent } from "#protocol/message.js";
import { getRuntimeActionRequestKey } from "#runtime/actions/keys.js";
import { FINAL_OUTPUT_TOOL_NAME } from "#runtime/framework-tools/final-output.js";
import type { InputRequest } from "#runtime/input/types.js";
import { hasEmptyDeliverySentinel } from "#shared/empty-delivery.js";
import type { JsonValue } from "#shared/json.js";
import { getWorkflowSandboxInterrupt } from "#shared/workflow-sandbox.js";

const log = createLogger("harness.generate");

/**
 * Classifies a parked session into the {@link GenerateOutcome} arm the loop
 * consumes: an interrupted `Workflow` sandbox dispatches its runtime
 * actions, a pending runtime-action batch parks with its request keys
 * (unresolved child work), and anything else is a human wait carrying the
 * park metadata the settle phase reads.
 */
export function classifyParkedSession(session: HarnessSession): GenerateOutcome {
  const workflowInterrupt = getPendingWorkflowInterrupt(session.state);
  if (
    workflowInterrupt !== undefined &&
    isWorkflowRuntimeActionInterrupt(workflowInterrupt.interrupt)
  ) {
    return {
      action: "dispatch-workflow-runtime-actions",
      pendingRuntimeActionKeys: getRuntimeActionKeysFromWorkflowInterrupt(
        workflowInterrupt.interrupt,
      ),
      state: session,
    };
  }

  const pendingAuthorization = getPendingAuthorization(session.state);
  const parked = {
    action: "park" as const,
    authorizationNames: pendingAuthorization?.challenges.map((challenge) => challenge.name),
    hasPendingAuthorization: pendingAuthorization !== undefined,
    hasPendingInputBatch: hasPendingInputBatch(session.state),
    state: session,
  };

  const batch = getPendingRuntimeActionBatch(session.state);
  if (batch !== undefined) {
    return {
      ...parked,
      pendingRuntimeActionKeys: batch.actions.map((action) => getRuntimeActionRequestKey(action)),
    };
  }
  return parked;
}

/**
 * Re-attaches a different state to a classified outcome without changing
 * the classification — e.g. after provider commit rewrites the session, or
 * when the durable boundary projects the harness outcome onto the
 * serialized session cursors.
 */
export function withOutcomeState<
  To extends LoopTypes,
  From extends LoopTypes & { readonly usage: To["usage"] } = HarnessLoopTypes,
>(outcome: TurnStepResult<From>, state: To["state"]): TurnStepResult<To> {
  switch (outcome.action) {
    case "continue":
      return { action: "continue", state };
    case "done":
      return {
        action: "done",
        isError: outcome.isError,
        output: outcome.output,
        state,
        usage: outcome.usage,
      };
    case "cancelled":
      return { action: "cancelled", state };
    case "park":
      return {
        action: "park",
        authorizationNames: outcome.authorizationNames,
        hasPendingAuthorization: outcome.hasPendingAuthorization,
        hasPendingInputBatch: outcome.hasPendingInputBatch,
        pendingRuntimeActionKeys: outcome.pendingRuntimeActionKeys,
        state,
      };
    case "dispatch-workflow-runtime-actions":
      return {
        action: "dispatch-workflow-runtime-actions",
        pendingRuntimeActionKeys: outcome.pendingRuntimeActionKeys,
        state,
      };
  }
}

/**
 * Processes the step result: extracts input requests, decides whether to
 * park, continue the tool loop, or terminate.
 */
export async function handleStepResult(input: {
  readonly config: GenerateConfig;
  readonly emit?: GenerateConfig["handleEvent"];
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly promptMessages: readonly ModelMessage[];
  readonly result: HarnessStepResult;
  readonly session: HarnessSession;
}): Promise<GenerateOutcome> {
  const { config, emit, promptMessages, result } = input;
  let { emissionState, session } = input;

  const resolvedStepOutput = resolveAssistantStepText(result.response.messages, result.text);
  const emptyDelivery =
    result.finishReason !== "tool-calls" &&
    result.toolCalls.length === 0 &&
    hasEmptyDeliverySentinel(resolvedStepOutput);
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
  const rawResponseMessages = emptyDelivery
    ? []
    : appendMissingToolResultMessages({
        append: invalidInputToolErrors.map((toolError) =>
          createToolResultMessagePartFromToolError(toolError),
        ),
        responseMessages: result.response.messages,
      });
  const stepOutput = emptyDelivery ? null : resolvedStepOutput;

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

  const baseSession: HarnessSession = {
    ...session,
    compaction: createNextCompactionConfig(session.compaction, promptMessages, result),
  };

  const workflowContinuationSecurity =
    config.workflow === true ? readWorkflowContinuationSecurity(baseSession) : undefined;

  if (workflowContinuationSecurity !== undefined) {
    const workflowInterrupt = await getWorkflowSandboxInterrupt(
      result,
      workflowContinuationSecurity,
    );
    if (workflowInterrupt !== undefined) {
      if (!isWorkflowRuntimeActionInterrupt(workflowInterrupt)) {
        throw new Error(`Unsupported Workflow interrupt kind "${workflowInterrupt.payload.kind}".`);
      }
      return parkOnWorkflowInterrupt({
        baseSession,
        emissionState,
        interrupt: workflowInterrupt,
        promptMessages,
        responseMessages,
      });
    }
  }

  const approvalRequests = extractToolApprovalInputRequests({
    content: result.content ?? [],
    excludedCallIds: invalidInputToolCallIds,
  });
  const approvalRequestCallIds = new Set(approvalRequests.map((request) => request.action.callId));
  const questionRequests = extractQuestionInputRequests({
    toolCalls: result.toolCalls,
    excludedCallIds: new Set([...invalidInputToolCallIds, ...approvalRequestCallIds]),
  });
  const inputRequests: InputRequest[] = [...approvalRequests, ...questionRequests];
  const advertisedRuntimeActionTools = getAdvertisedTools({
    session: baseSession,
    tools: config.tools,
  });
  const pendingRuntimeActions = ((result.toolCalls ?? []) as TypedToolCall<ToolSet>[])
    .filter((toolCall) => !invalidInputToolCallIds.has(toolCall.toolCallId))
    .filter((toolCall) => config.tools.get(toolCall.toolName)?.runtimeAction !== undefined)
    .filter((toolCall) => {
      if (advertisedRuntimeActionTools.get(toolCall.toolName)?.runtimeAction !== undefined) {
        return true;
      }
      log.warn("runtime action tool call blocked because tool is not advertised", {
        callId: toolCall.toolCallId,
        sessionId: baseSession.sessionId,
        toolName: toolCall.toolName,
      });
      return false;
    })
    .map((toolCall) =>
      createRuntimeActionRequestFromToolCall({
        toolCall,
        tools: advertisedRuntimeActionTools,
      }),
    );

  if (pendingRuntimeActions.length > 0) {
    // Stamp the live emission state onto the parked session so the
    // resume turn is classified as a continuation (turnId set), not a
    // fresh turn. Every other park path does this; without it the
    // parked session carries the default emission state (turnId ""),
    // because the post-preamble `setHarnessEmissionState` is dropped by
    // the later `session = pending.session` / `maybeCompact` rebinds.
    return classifyParkedSession(
      setHarnessEmissionState(
        setPendingRuntimeActionBatch({
          actions: pendingRuntimeActions,
          event: {
            sequence: emissionState.sequence,
            stepIndex: emissionState.stepIndex,
            turnId: emissionState.turnId,
          },
          responseMessages,
          session: { ...baseSession, history: [...promptMessages] },
        }),
        emissionState,
      ),
    );
  }

  // --- Park on input requests -----------------------------------------------

  if (inputRequests.length > 0) {
    let parkedSession = setPendingInputBatch({
      event: {
        sequence: emissionState.sequence,
        stepIndex: emissionState.stepIndex,
        turnId: emissionState.turnId,
      },
      requests: inputRequests,
      responseMessages,
      session: { ...baseSession, history: [...promptMessages] },
    });

    if (emit) {
      await emit(
        createInputRequestedEvent({
          requests: inputRequests,
          sequence: emissionState.sequence,
          stepIndex: emissionState.stepIndex,
          turnId: emissionState.turnId,
        }),
      );

      if (config.mode === "conversation") {
        emissionState = await emitTurnEpilogue(
          emit,
          emissionState,
          config.mode,
          parkedSession.continuationToken,
        );
        parkedSession = setHarnessEmissionState(parkedSession, emissionState);
      }
    }

    return classifyParkedSession(parkedSession);
  }

  // --- Park on authorization request ------------------------------------------

  const authSignal = findAuthorizationSignalFromToolResults(result.toolResults);
  if (authSignal) {
    const { challenges } = authSignal;

    if (emit) {
      for (const ch of challenges) {
        await emit(
          createAuthorizationRequiredEvent({
            authorization: ch.challenge,
            name: ch.name,
            description: ch.challenge.instructions ?? `Authorization required for ${ch.name}`,
            webhookUrl: ch.hookUrl,
            sequence: emissionState.sequence,
            stepIndex: emissionState.stepIndex,
            turnId: emissionState.turnId,
          }),
        );
      }
    }

    return classifyParkedSession(
      setHarnessEmissionState(
        {
          ...baseSession,
          history: [...promptMessages],
          state: setPendingAuthorization(baseSession.state, { challenges }),
        },
        emissionState,
      ),
    );
  }

  // --- Continue or terminate ------------------------------------------------

  // History grows by append only; nothing rewrites earlier messages mid-turn,
  // so the prompt prefix stays stable and the provider's prompt cache keeps
  // hitting across steps. Compaction is the sole mechanism that ever rewrites
  // history, and it runs before the model call (see `maybeCompact`).
  const continuationMessages = responseMessages;
  const updatedHistory: ModelMessage[] = [...promptMessages, ...continuationMessages];
  let nextSession: HarnessSession = { ...baseSession, history: updatedHistory };

  // A `final_output` call is terminal even when the model emits it alongside
  // executing tools: continuing the loop would leave the no-execute call as a
  // dangling tool_use the next provider call rejects, and drop the result.
  const calledFinalOutput =
    nextSession.outputSchema !== undefined && extractFinalOutput(result) !== undefined;

  const continueLoop =
    !calledFinalOutput &&
    (continuationMessages.at(-1)?.role === "tool" ||
      normalizedProviderHistory.outcomeEndsResponse ||
      hasDeferredStepInput(nextSession));
  if (continueLoop) {
    if (emit) {
      emissionState = advanceStep(emissionState);
      nextSession = setHarnessEmissionState(nextSession, emissionState);
    }

    return { action: "continue", state: nextSession };
  }

  // `mode` is the fundamental terminal split: a task run must finish (an unmet
  // schema becomes an error), a conversation run may park. Whether a schema is
  // in effect is mode-independent — it is resolved once at the execution layer
  // and read straight off the session here.
  if (config.mode === "task") {
    return finishTaskTurn({
      emissionState,
      emit,
      history: promptMessages,
      result,
      schema: nextSession.outputSchema,
      session: nextSession,
      stepOutput,
    });
  }

  return finishConversationTurn({
    emissionState,
    emit,
    history: promptMessages,
    result,
    schema: nextSession.outputSchema,
    session: nextSession,
  });
}

export const OUTPUT_SCHEMA_NOT_FULFILLED = {
  code: "OUTPUT_SCHEMA_NOT_FULFILLED",
  message: "The agent could not produce a result matching the requested schema.",
} as const;

/**
 * The structured value the model delivered by calling the framework
 * `final_output` tool, or `undefined` when the terminal turn ended in prose.
 */
export function extractFinalOutput(result: HarnessStepResult): JsonValue | undefined {
  return (result.toolCalls ?? []).find(
    (call) => call.toolName === FINAL_OUTPUT_TOOL_NAME && !isInvalidToolCall(call),
  )?.input as JsonValue | undefined;
}

/**
 * Persists the structured value as the assistant turn rather than the
 * un-executed `final_output` call, which would be a dangling tool_use on the
 * next turn. Clearing the run-scoped schema keeps it scoped to this turn.
 */
export function persistStructuredAssistantTurn(
  session: HarnessSession,
  history: readonly ModelMessage[],
  structured: JsonValue,
): HarnessSession {
  return {
    ...session,
    history: [...history, { content: JSON.stringify(structured), role: "assistant" }],
    outputSchema: undefined,
  };
}

/**
 * Creates an approval-key resolver from the tool map. The resolver computes
 * compound keys at recording time instead of pre-computing and persisting
 * them on the pending batch.
 */
export function resolveApprovalKeyFromTools(
  tools: HarnessToolMap,
): (request: InputRequest) => string | undefined {
  return (request) => {
    const toolDef = tools.get(request.action.toolName);
    if (toolDef?.approvalKey === undefined) {
      return undefined;
    }
    return toolDef.approvalKey(request.action.input);
  };
}

function findAuthorizationSignalFromToolResults(
  toolResults: readonly TypedToolResult<ToolSet>[] | undefined,
): AuthorizationSignal | undefined {
  const ctx = contextStorage.getStore();
  if (ctx !== undefined) {
    for (const toolResult of toolResults ?? []) {
      const stashed = readToolInterrupt(ctx, toolResult.toolCallId);
      if (stashed !== undefined && isAuthorizationSignal(stashed)) {
        return stashed;
      }
    }
  }

  for (const toolResult of toolResults ?? []) {
    if (isAuthorizationSignal(toolResult.output)) {
      return toolResult.output;
    }
  }

  return undefined;
}
