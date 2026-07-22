import { context as otelContext, type Span, trace } from "#compiled/@opentelemetry/api/index.js";
import {
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type TelemetryOptions,
} from "ai";
import { isScheduleAppAuth } from "#channel/schedule-auth.js";
import { createErrorId, createLogger, recordErrorOnSpan } from "#internal/logging.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, ParentSessionKey } from "#context/keys.js";
import { buildDynamicInstructionMessages } from "#context/dynamic-instruction-lifecycle.js";
import { PendingSkillAnnouncementKey } from "#context/dynamic-skill-lifecycle.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  createActionResultEvent,
  createCompactionCompletedEvent,
  createCompactionRequestedEvent,
  createStepStartedEvent,
} from "#protocol/message.js";
import {
  hydrateSandboxAttachments,
  stageAttachmentsToSandbox,
} from "#harness/attachment-staging.js";
import {
  compactMessages,
  getInputTokenCount,
  resolveCompactionModel,
  shouldCompact,
} from "#harness/compaction.js";
import {
  accumulateTurnUsage,
  extractGatewayCostUsd,
  extractTokenUsageDelta,
  getTurnUsageState,
  setTurnUsageState,
} from "#harness/turn-tag-state.js";
import {
  applySessionLimitContinuation,
  enforceSessionTokenLimit,
} from "#harness/session-limit-enforcement.js";
import {
  emitFailedStep,
  emitRecoverableFailedTurn,
  emitStepStarted,
  emitTurnEpilogue,
  emitTurnPreamble,
  getHarnessEmissionState,
  setHarnessEmissionState,
} from "#harness/emission.js";
import {
  consumeDeferredStepInput,
  getApprovedTools,
  getPendingInputRequestIds,
  hasStepInput,
  resolvePendingInput,
} from "#harness/input-requests.js";
import { normalizeUserContent } from "#harness/messages.js";
import { convertStaleResponsesToUserMessage } from "#harness/stale-input-responses.js";
import { getInstrumentationConfig } from "#harness/instrumentation-config.js";
import {
  classifyModelCallError,
  EmptyModelResponseError,
  extractModelCallErrorDetails,
  extractUpstreamRejectionMessage,
} from "#harness/model-call-error.js";
import { summarizeKnownError } from "#harness/semantic-errors/index.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { CONDITIONAL_DELIVERY_INSTRUCTION } from "#shared/empty-delivery.js";
import { extractWorkflowStreamWriteErrorDetails } from "#harness/workflow-stream-error.js";
import {
  enrichTelemetry,
  ensureOtelIntegration,
  resolveStepOtelContext,
  setTurnTraceState,
} from "#harness/otel-integration.js";
import { detectPromptCachePath, getAnthropicCacheMarker } from "#harness/prompt-cache.js";
import { resolvePendingRuntimeActions } from "#harness/runtime-actions.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import {
  classifyParkedSession,
  handleStepResult,
  resolveApprovalKeyFromTools,
} from "#harness/step-result.js";
import {
  attemptEmptyResponseRecovery,
  attemptUnsupportedProviderToolRecovery,
  buildModelCallFailureDetails,
  buildModelCallFailureLogFields,
  runModelCallRecoveryPipeline,
} from "#harness/model-call-recovery.js";
import {
  buildGatewayAttributionHeaders,
  createModelCallRunner,
  environment,
  eveVersion,
  resolveActiveRuntimeModel,
} from "#harness/model-call.js";
import { continuePendingWorkflowInterrupt } from "#harness/workflow-interrupt-continuation.js";
import type {
  GenerateOutcome,
  HarnessSession,
  GenerateFn,
  StepInput,
  GenerateConfig,
} from "#harness/types.js";

/**
 * Creates a generate harness step function backed by AI SDK `ToolLoopAgent`.
 */

const log = createLogger("harness.generate");

export function createGenerate(config: GenerateConfig): GenerateFn {
  const emit = config.handleEvent;
  const telemetryConfig = getInstrumentationConfig();
  if (telemetryConfig !== undefined) {
    ensureOtelIntegration();
  }
  const tracer = telemetryConfig !== undefined ? trace.getTracer("eve") : undefined;
  const agentName = config.runtimeIdentity?.agentName;

  async function runStep(
    initialSession: Readonly<Parameters<GenerateFn>[0]>,
    input?: StepInput,
  ): Promise<GenerateOutcome> {
    // --- Turn span lifecycle ------------------------------------------------

    // First step of a turn: open a new parent span. Continuation steps
    // restore the parent from session state via resolveStepOtelContext.
    let turnSpan: Span | undefined;
    if (tracer && hasStepInput(input)) {
      const functionId = telemetryConfig?.functionId ?? agentName;
      const attributes: Record<string, string> = {
        "eve.version": eveVersion,
        "eve.environment": environment,
        "eve.session.id": initialSession.sessionId,
      };
      if (functionId) {
        attributes["ai.telemetry.functionId"] = functionId;
      }
      turnSpan = tracer.startSpan("ai.eve.turn", { attributes });
    }

    // Run the step body inside the turn span's (or restored parent's)
    // OTel context so AI SDK spans nest as children.
    const parentContext = resolveStepOtelContext(tracer, turnSpan, initialSession);
    const executeStep = () => executeStepBody(initialSession, input, turnSpan);

    try {
      if (parentContext) {
        return await otelContext.with(parentContext, executeStep);
      }
      return await executeStep();
    } finally {
      turnSpan?.end();
    }
  }

  async function executeStepBody(
    initialSession: Readonly<Parameters<GenerateFn>[0]>,
    input?: StepInput,
    turnSpan?: Span,
  ): Promise<GenerateOutcome> {
    let session = initialSession;

    // Store the turn span context on the session so continuation steps
    // can restore the parent trace across step boundaries.
    if (turnSpan) {
      session = setTurnTraceState(session, turnSpan.spanContext());
    }

    let emissionState = getHarnessEmissionState(session.state);

    // Resolve deferred input, runtime actions, then HITL input; each stage
    // may park when its resume payload has not arrived.

    const stepInput = consumeDeferredStepInput({ input, session });
    session = stepInput.session;

    const resolvedRuntimeActions = await resolvePendingRuntimeActions({
      emit,
      session,
      stepInput: stepInput.input,
    });
    if (resolvedRuntimeActions.outcome === "unresolved") {
      return classifyParkedSession(resolvedRuntimeActions.session);
    }
    session = resolvedRuntimeActions.session;

    const staleConversion = convertStaleResponsesToUserMessage({
      history: resolvedRuntimeActions.messages,
      pendingRequestIds: getPendingInputRequestIds(session.state),
      stepInput: stepInput.input,
    });
    const effectiveStepInput = staleConversion.stepInput;
    const preambleStepInput =
      staleConversion.kind === "converted"
        ? { ...effectiveStepInput, message: staleConversion.displayMessage }
        : effectiveStepInput;

    const pending = resolvePendingInput({
      history: resolvedRuntimeActions.messages,
      resolveApprovalKey: resolveApprovalKeyFromTools(config.tools),
      session,
      stepInput: effectiveStepInput,
    });
    if (pending.outcome === "unresolved") {
      if (emit && pending.deferredMessage === true && hasStepInput(input)) {
        emissionState = await emitTurnPreamble(
          emit,
          preambleStepInput ?? {},
          emissionState,
          config.runtimeIdentity,
        );
        emissionState = await emitTurnEpilogue(
          emit,
          emissionState,
          config.mode,
          pending.session.continuationToken,
        );
        return classifyParkedSession(setHarnessEmissionState(pending.session, emissionState));
      }

      return classifyParkedSession(pending.session);
    }

    // Surface denied tool-call approvals as rejected `action.result` events.
    // The denial otherwise lives only in model history, so consumers (e.g.
    // observability) never see the tool call resolve. Attributed to the turn
    // that requested approval via the parked batch's emit coordinates.
    if (emit && pending.rejectedActions) {
      for (const result of pending.rejectedActions.results) {
        await emit(
          createActionResultEvent({
            rejected: true,
            result,
            sequence: pending.rejectedActions.event.sequence,
            stepIndex: pending.rejectedActions.event.stepIndex,
            turnId: pending.rejectedActions.event.turnId,
          }),
        );
      }
    }

    // --- Turn preamble ------------------------------------------------------

    if (emit && hasStepInput(input)) {
      emissionState = await emitTurnPreamble(
        emit,
        preambleStepInput ?? {},
        emissionState,
        config.runtimeIdentity,
      );
      session = setHarnessEmissionState(session, emissionState);

      if (turnSpan) {
        turnSpan.setAttribute("eve.turn.id", emissionState.turnId);
      }
    }

    session = pending.session;
    let messages: ModelMessage[] = pending.messages;

    // A resolved session-limit continuation prompt grants a fresh token
    // budget or ends the session; see session-limit-enforcement.
    const continuation = await applySessionLimitContinuation({
      config,
      emit,
      emissionState,
      limitContinuation: pending.limitContinuation,
      session,
    });
    if (continuation.result !== null) {
      return continuation.result;
    }
    session = continuation.session;

    if (effectiveStepInput?.context !== undefined && pending.deferredContext !== true) {
      for (const entry of effectiveStepInput.context) {
        messages.push({ content: entry, role: "user" });
      }
    }

    const userContent = normalizeUserContent(effectiveStepInput?.message);
    if (userContent !== undefined && !pending.deferredMessage && !pending.consumedMessage) {
      // Staging writes FilePart bytes into the sandbox and replaces
      // each part's `data` with a compact `eve-sandbox:` URL. The
      // `messages` array — and everything that flows into
      // `session.history` from it — therefore never carries raw
      // attachment bytes across step boundaries.
      const content = await stageAttachmentsToSandbox(userContent);
      messages.push({ content, role: "user" });
    }

    // --- Model + tools ------------------------------------------------------

    // Direct harness unit tests may run without an ambient context.
    const ctx = contextStorage.getStore();
    if (ctx !== undefined && config.dispatchDynamicModelEvent !== undefined) {
      await config.dispatchDynamicModelEvent({
        ctx,
        event: createStepStartedEvent({
          sequence: emissionState.sequence,
          stepIndex: emissionState.stepIndex,
          turnId: emissionState.turnId,
        }),
        fallback: session.agent.dynamicModelDefaultReference ?? session.agent.modelReference,
        messages,
      });
    }
    const resolvedModel = await resolveActiveRuntimeModel({
      config,
      ctx,
      session,
    });
    session = resolvedModel.session;
    const model = resolvedModel.model;
    const cachePath = detectPromptCachePath(model);
    const marker = cachePath.kind === "anthropic-direct" ? getAnthropicCacheMarker() : undefined;

    // --- Compaction ---------------------------------------------------------
    //
    // Runs before `agent.stream()` so the compacted messages flow through
    // `messages` (which the harness uses to rebuild session history).
    const attributionHeaders = buildGatewayAttributionHeaders(model, config.runtimeIdentity);

    ({ messages, session } = await maybeCompact({
      abortSignal: config.abortSignal,
      emit,
      emissionState,
      messages,
      model,
      onCompaction: config.onCompaction,
      resolveModel: config.resolveModel,
      runtimeIdentity: config.runtimeIdentity,
      session,
      telemetry: enrichTelemetry(telemetryConfig, agentName) ?? undefined,
    }));

    const approvedTools = getApprovedTools(session);

    const emptyDeliveryEnabled =
      session.outputSchema === undefined &&
      ctx !== undefined &&
      isScheduleAppAuth(ctx.get(AuthKey)) &&
      ctx.get(ParentSessionKey) === undefined;

    // --- Execute via ToolLoopAgent ------------------------------------------

    /*
     * The `onError` override suppresses the AI SDK's default
     * `console.error(error)` handler inside `streamText`. Errors are
     * handled by the harness catch block and emitted as stream events.
     */
    // Hydrate `eve-sandbox:` ref FileParts into inline bytes for the
    // model call only. The result is transient — `messages` itself
    // remains ref-only so it can flow into `session.history` without
    // bloating every future step boundary.
    const hydratedMessages = await hydrateSandboxAttachments(messages);

    // AI SDK rejects role:"system" in `messages` — route system entries
    // from durable history to `instructions` instead.
    const systemMessages: SystemModelMessage[] = [];
    const nonSystemMessages: ModelMessage[] = [];
    for (const entry of hydratedMessages) {
      if (entry.role === "system") {
        systemMessages.push(entry);
      } else {
        nonSystemMessages.push(entry);
      }
    }
    if (ctx !== undefined) {
      systemMessages.push(...buildDynamicInstructionMessages(ctx));
      const skillAnnouncement = ctx.get(PendingSkillAnnouncementKey);
      if (skillAnnouncement !== undefined && skillAnnouncement.length > 0) {
        systemMessages.push({ role: "system", content: skillAnnouncement });
      }
    }
    if (emptyDeliveryEnabled) {
      systemMessages.push({ role: "system", content: CONDITIONAL_DELIVERY_INSTRUCTION });
    }

    const modelMessages = nonSystemMessages;

    const modelCall = createModelCallRunner({
      agentName,
      approvedTools,
      attributionHeaders,
      cachePath,
      config,
      ctx,
      emissionState,
      emit,
      marker,
      model,
      modelMessages,
      session,
      systemMessages,
      telemetryConfig,
    });

    // Resolve first-attempt instrumentation before step.started dispatch
    // allows dynamic tool resolvers to update the effective toolset.
    const initialModelCallInput = modelCall.prepareModelCallInput();

    // Emit step.started before building the toolset so dynamic tool
    // resolvers subscribed to step.started write to LiveStepToolsKey.
    if (emit) {
      await emitStepStarted(emit, emissionState, messages);
    }

    // Workflow continuations replay the sandbox after step.started so nested
    // action lifecycle events keep the active turn's emission coordinates.
    const pendingWorkflowInterrupt = await continuePendingWorkflowInterrupt({
      childResults: effectiveStepInput?.runtimeActionResults,
      config,
      emit,
      emissionState,
      session,
    });
    if (pendingWorkflowInterrupt !== null) {
      return pendingWorkflowInterrupt;
    }

    const limitResult = await enforceSessionTokenLimit({
      config,
      emit,
      emissionState,
      messages,
      session,
    });
    if (limitResult !== null) {
      return limitResult;
    }

    let result: HarnessStepResult;
    try {
      result = await modelCall.runOneModelCall({
        preparedInput: initialModelCallInput,
        suppressStepStartedEmission: true,
      });
    } catch (error) {
      throwIfTurnAborted(config.abortSignal);

      // Stage order: drop a gateway-rejected provider tool first, then
      // reissue an empty response; see runModelCallRecoveryPipeline for
      // the skip/act semantics.
      const recoveryResult = await runModelCallRecoveryPipeline({
        error,
        stages: [
          (current) =>
            attemptUnsupportedProviderToolRecovery({
              error: current.error,
              runOneModelCall: modelCall.runOneModelCall,
              sessionId: session.sessionId,
              turnId: emissionState.turnId,
            }),
          (current) =>
            attemptEmptyResponseRecovery({
              emptyDeliveryEnabled,
              error: current.error,
              retryCallOptions: current.retryCallOptions,
              runOneModelCall: modelCall.runOneModelCall,
              sessionId: session.sessionId,
              turnId: emissionState.turnId,
            }),
        ],
      });
      throwIfTurnAborted(config.abortSignal);
      session = modelCall.currentSession();

      if (recoveryResult.outcome === "recovered") {
        result = recoveryResult.result;
      } else {
        // Surface the full cause chain + upstream responseBody to OTel
        // via the turn span. The AI SDK's automatic
        // `span.recordException(err)` on its own `ai.streamText` span
        // only captures `error.stack` and does not traverse `cause`,
        // so the gateway-wrapped upstream 4xx body would otherwise be
        // invisible to OTel providers.
        const finalError = recoveryResult.error;
        if (turnSpan) {
          recordErrorOnSpan(turnSpan, finalError);
        }

        if (!emit) {
          // Internal harness callers without an emit fn (tests, task-only
          // code paths) get the raw throw. Only runtime-connected harness
          // calls go through the structured failure path below.
          throw finalError;
        }

        // A durable event-stream write failure reaches this catch only
        // because `emitStreamContent` runs inside the model-call
        // try/catch — the model call itself may have succeeded. Label it
        // as the workflow-infrastructure failure it is instead of
        // misattributing it to the model provider, and surface the
        // failing endpoint + platform error code as evidence.
        const streamWriteDetails = extractWorkflowStreamWriteErrorDetails(finalError);
        if (streamWriteDetails !== null) {
          const errorId = createErrorId();
          log.error("workflow stream write failed — parking session for retry by the user", {
            ...streamWriteDetails,
            errorId,
            error: finalError,
            sessionId: session.sessionId,
            turnId: emissionState.turnId,
          });
          emissionState = await emitRecoverableFailedTurn(emit, emissionState, {
            code: "WORKFLOW_STREAM_WRITE_FAILED",
            continuationToken: session.continuationToken,
            details: { ...streamWriteDetails, errorId },
            message: toErrorMessage(finalError),
          });
          const parkedSession = setHarnessEmissionState(session, emissionState);
          return classifyParkedSession(parkedSession);
        }

        const classification = classifyModelCallError(finalError);
        const errorId = createErrorId();
        const catalogSummary = summarizeKnownError(finalError);
        const upstreamRejection =
          catalogSummary === null ? extractUpstreamRejectionMessage(finalError) : null;
        const errorMessage =
          catalogSummary?.message ?? upstreamRejection?.message ?? toErrorMessage(finalError);
        // Task failures surface as the parent agent's tool-result text, so
        // the remediation rides along in prose — the parent can act on it
        // or relay it. Event payloads keep hint structured in details.
        const taskFailureOutput =
          catalogSummary?.hint === undefined
            ? errorMessage
            : `${errorMessage} ${catalogSummary.hint}`;
        const modelCallDetails = extractModelCallErrorDetails(finalError);
        const details = buildModelCallFailureDetails({
          catalogSummary,
          error: finalError,
          errorId,
          modelCallDetails,
          upstreamRejection,
        });
        const modelCallLogFields = buildModelCallFailureLogFields({
          error: finalError,
          errorId,
          modelCallDetails,
          recognized: catalogSummary !== null || upstreamRejection !== null,
          sessionId: session.sessionId,
          turnId: emissionState.turnId,
        });

        if (classification === "terminal") {
          if (catalogSummary !== null) {
            // Recognized configuration failure: log a concise single line
            // and skip the structured SDK dump so the user sees an
            // actionable hint instead of a wall of inspector output.
            log.error(`${catalogSummary.name}: ${catalogSummary.message}`, {
              errorId,
              hint: catalogSummary.hint,
              sessionId: session.sessionId,
              turnId: emissionState.turnId,
            });
          } else {
            log.error(
              upstreamRejection?.message ?? "model call failed terminally",
              modelCallLogFields,
            );
          }
          await emitFailedStep(emit, emissionState, {
            code: "MODEL_CALL_FAILED",
            details,
            message: errorMessage,
            sessionId: session.sessionId,
          });
          // In task mode (delegated subagent runs) the terminal failure
          // must be the task's error result so the parent driver resumes
          // with a failed `subagent-result` instead of a successful empty
          // output (https://github.com/vercel/eve/issues/412).
          return config.mode === "task"
            ? { action: "done", isError: true, output: taskFailureOutput, state: session }
            : { action: "done", output: "", state: session };
        }

        if (config.mode === "task") {
          if (
            classification === "recoverable" &&
            !(finalError instanceof EmptyModelResponseError)
          ) {
            // Task runs cannot park for user-driven recovery. Let the durable
            // step retry from committed session state, but only for errors
            // that did not already consume the in-process transient budget or
            // the dedicated empty-response reissue.
            log.warn(
              upstreamRejection?.message ??
                "model call failed recoverably in task mode — rethrowing for durable step retry",
              modelCallLogFields,
            );
            throw finalError;
          }

          // A task run cannot park for a user retry (turnWorkflow rejects
          // a waiting park in task mode). Classified transient errors arrive
          // here only after their bounded in-process retries are exhausted;
          // empty responses already received their specialized reissue.
          log.error(
            upstreamRejection?.message ?? "model call failed; failing the task run",
            modelCallLogFields,
          );
          await emitFailedStep(emit, emissionState, {
            code: "MODEL_CALL_FAILED",
            details,
            message: errorMessage,
            sessionId: session.sessionId,
          });
          return { action: "done", isError: true, output: taskFailureOutput, state: session };
        }

        log.error(
          upstreamRejection?.message ?? "model call failed — parking session for retry by the user",
          modelCallLogFields,
        );
        emissionState = await emitRecoverableFailedTurn(emit, emissionState, {
          code: "MODEL_CALL_FAILED",
          continuationToken: session.continuationToken,
          details,
          message: errorMessage,
        });
        const parkedSession = setHarnessEmissionState(session, emissionState);
        return classifyParkedSession(parkedSession);
      }
    }
    session = modelCall.currentSession();

    // --- Step-side observability tags ---------------------------------------
    //
    // Tag the **turn workflow run** (the current `"use step"` is hosted by
    // that workflow, so `experimental_setAttributes` writes to its
    // attributes table) with the model id and per-turn cumulative token
    // counts. Per-turn totals are accumulated on `session.state` because
    // each tool-loop iteration is a fresh `"use step"` and the workflow
    // runtime's last-write-wins per-key semantics mean only the running
    // total — not the per-step delta — should reach the dashboard.
    //
    // Best-effort: the runtime-injected writer swallows runtime failures
    // so a broken tag emit can never break the agent loop.
    const nextTurnUsage = accumulateTurnUsage({
      previous: getTurnUsageState(session.state),
      turnId: emissionState.turnId,
      usage: extractTokenUsageDelta({
        costUsd: extractGatewayCostUsd(result.providerMetadata),
        usage: result.usage,
      }),
    });
    session = setTurnUsageState(session, nextTurnUsage);
    // `formatLanguageModelGatewayId` requires `model.provider` to be a string;
    // mock models in tests omit it, so guard the lookup so a missing field
    // becomes `undefined` and is dropped by the attribute writer instead of
    // throwing into the tool loop.
    let modelTag: string | undefined;
    try {
      modelTag = formatLanguageModelGatewayId(model);
    } catch {
      modelTag = undefined;
    }
    await config.writeEveAttributes?.({
      "$eve.model": modelTag,
      "$eve.input_tokens": nextTurnUsage.inputTokens,
      "$eve.output_tokens": nextTurnUsage.outputTokens,
      "$eve.cache_read_tokens": nextTurnUsage.cacheReadTokens,
      "$eve.cache_write_tokens": nextTurnUsage.cacheWriteTokens,
      "$eve.cost_usd": nextTurnUsage.sawCost ? nextTurnUsage.costUsd : undefined,
      "$eve.tool_count": config.tools.size,
    });

    // --- Handle result ------------------------------------------------------

    return handleStepResult({
      config,
      emit,
      emissionState,
      promptMessages: messages,
      result,
      session,
    });
  }

  return runStep;
}

/**
 * Runs the compaction pipeline once if the session's input-token estimate
 * is over the configured threshold. Mutates neither input; returns the new
 * messages array and (possibly updated) session.
 *
 * Kept in the tool-loop (rather than the AI SDK's `prepareStep` hook) so
 * the compacted messages flow through the same `messages` variable the
 * harness uses to rebuild `session.history` after the step.
 */
async function maybeCompact(input: {
  readonly abortSignal?: AbortSignal;
  readonly emit?: GenerateConfig["handleEvent"];
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly messages: ModelMessage[];
  readonly model: LanguageModel;
  readonly onCompaction?: GenerateConfig["onCompaction"];
  readonly resolveModel: GenerateConfig["resolveModel"];
  readonly runtimeIdentity?: GenerateConfig["runtimeIdentity"];
  readonly session: HarnessSession;
  readonly telemetry?: TelemetryOptions;
}): Promise<{ readonly messages: ModelMessage[]; readonly session: HarnessSession }> {
  const { emit, emissionState } = input;
  let messages = input.messages;
  const session = input.session;

  if (!shouldCompact(messages, session.compaction)) {
    return { messages, session };
  }

  const compaction = await resolveCompactionModel({
    compactionModelReference: session.agent.compactionModelReference,
    model: input.model,
    modelReference: session.agent.modelReference,
    resolveModel: input.resolveModel,
  });

  if (emit) {
    await emit(
      createCompactionRequestedEvent({
        modelId: formatLanguageModelGatewayId(compaction.model),
        sequence: emissionState.sequence,
        sessionId: session.sessionId,
        turnId: emissionState.turnId,
        usageInputTokens: getInputTokenCount(messages, session.compaction),
      }),
    );
  }

  messages = await compactMessages(
    messages,
    compaction.model,
    session.compaction,
    compaction.providerOptions,
    input.telemetry,
    buildGatewayAttributionHeaders(compaction.model, input.runtimeIdentity),
    input.abortSignal,
  );

  if (input.onCompaction) {
    for (const msg of input.onCompaction()) {
      messages.push(msg);
    }
  }

  if (emit) {
    await emit(
      createCompactionCompletedEvent({
        modelId: formatLanguageModelGatewayId(compaction.model),
        sequence: emissionState.sequence,
        sessionId: session.sessionId,
        turnId: emissionState.turnId,
      }),
    );
  }

  return { messages, session };
}
