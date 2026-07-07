import {
  context as otelContext,
  type Span,
  type SpanContext,
  trace,
} from "#compiled/@opentelemetry/api/index.js";
import {
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  type ProviderMetadata,
  type SystemModelMessage,
  type TelemetryOptions,
  ToolLoopAgent,
  type ToolSet,
  type TypedToolCall,
  type TypedToolError,
  type TypedToolResult,
} from "ai";
import { isScheduleAppAuth } from "#channel/schedule-auth.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  createErrorId,
  createLogger,
  formatError,
  logError,
  recordErrorOnSpan,
} from "#internal/logging.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, ParentSessionKey } from "#context/keys.js";
import { buildDynamicInstructionMessages } from "#context/dynamic-instruction-lifecycle.js";
import { getActiveDynamicModelSelection } from "#context/dynamic-model-lifecycle.js";
import { buildDynamicTools } from "#context/build-dynamic-tools.js";
import { PendingSkillAnnouncementKey } from "#context/dynamic-skill-lifecycle.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  createActionResultEvent,
  createCompactionCompletedEvent,
  createCompactionRequestedEvent,
  createInputRequestedEvent,
  createResultCompletedEvent,
  createStepStartedEvent,
} from "#protocol/message.js";
import type { InstrumentationDefinition } from "#public/instrumentation/index.js";
import { ASK_QUESTION_TOOL_NAME } from "#runtime/framework-tools/ask-question.js";
import {
  getWorkflowRuntimeActionInterrupts,
  isWorkflowRuntimeActionInterrupt,
} from "#harness/workflow-runtime-action-state.js";
import type { InputRequest } from "#runtime/input/types.js";
import {
  hydrateSandboxAttachments,
  stageAttachmentsToSandbox,
} from "#harness/attachment-staging.js";
import { buildWorkflowHostTools } from "#harness/workflow-sandbox.js";
import {
  getWorkflowContinuationSecurity,
  readWorkflowContinuationSecurity,
} from "#harness/workflow-continuation-security.js";
import { createWorkflowLifecycle } from "#harness/workflow-lifecycle.js";
import {
  clearPendingWorkflowInterrupt,
  getPendingWorkflowInterrupt,
  setPendingWorkflowInterrupt,
} from "#harness/workflow-interrupt-state.js";
import {
  compactMessages,
  getInputTokenCount,
  resolveCompactionModel,
  shouldCompact,
} from "#harness/compaction.js";
import {
  accumulateTurnUsage,
  getTurnUsageState,
  setTurnUsageState,
  type TokenUsageDelta,
} from "#harness/turn-tag-state.js";
import {
  applySessionLimitContinuation,
  enforceSessionTokenLimit,
} from "#harness/session-limit-enforcement.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";
import {
  advanceStep,
  emitFailedStep,
  emitRecoverableFailedTurn,
  emitStepStarted,
  emitStreamContent,
  emitTurnEpilogue,
  emitTurnPreamble,
  getHarnessEmissionState,
  setHarnessEmissionState,
} from "#harness/emission.js";
import {
  extractQuestionInputRequests,
  extractToolApprovalInputRequests,
} from "#harness/input-extraction.js";
import { createToolResultMessagePartFromToolError } from "#harness/action-result-helpers.js";
import { buildTelemetryRuntimeContext } from "#harness/instrumentation-runtime-context.js";
import {
  consumeDeferredStepInput,
  getApprovedTools,
  hasDeferredStepInput,
  hasStepInput,
  resolvePendingInput,
  setPendingInputBatch,
} from "#harness/input-requests.js";
import { getInstrumentationConfig } from "#harness/instrumentation-config.js";
import { resolveAssistantStepText } from "#harness/messages.js";
import { normalizeProviderToolHistory } from "#harness/provider-tool-history.js";
import {
  type AuthorizationSignal,
  isAuthorizationSignal,
  setPendingAuthorization,
} from "#harness/authorization.js";
import { readToolInterrupt } from "#harness/tool-interrupts.js";
import { createAuthorizationRequiredEvent } from "#protocol/message.js";
import {
  classifyModelCallError,
  EmptyModelResponseError,
  extractModelCallErrorDetails,
  extractUnsupportedProviderToolTypes,
  isNoOutputGeneratedError,
  type ModelCallConfigErrorSummary,
  summarizeKnownModelCallConfigError,
  summarizeKnownModelCallRequestError,
} from "#harness/model-call-error.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import {
  CONDITIONAL_DELIVERY_INSTRUCTION,
  EMPTY_DELIVERY_SENTINEL,
  hasEmptyDeliverySentinel,
} from "#shared/empty-delivery.js";
import { extractWorkflowStreamWriteErrorDetails } from "#harness/workflow-stream-error.js";
import { ensureOtelIntegration } from "#harness/otel-integration.js";
import { getAdvertisedTools } from "#harness/advertised-tools.js";
import {
  applyLastToolCacheBreakpoint,
  applySystemCacheBreakpoint,
  detectPromptCachePath,
  getAnthropicCacheMarker,
} from "#harness/prompt-cache.js";
import { resolveFrameworkToolFromUpstreamType } from "#harness/provider-tools.js";
import {
  createRuntimeActionRequestFromToolCall,
  resolvePendingRuntimeActions,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import { getInvalidToolCallInputError } from "#harness/tool-call-input-errors.js";
import {
  buildStepHooks,
  emitStepActions,
  type HarnessStepResult,
  isInvalidToolCall,
} from "#harness/step-hooks.js";
import {
  buildToolApproval,
  buildToolSetFromDefinitions,
  buildToolSetWithProviderTools,
} from "#harness/tools.js";
import {
  continueWorkflowSandboxInterrupt,
  getWorkflowSandboxInterrupt,
  type WorkflowSandboxInterrupt,
  unwrapWorkflowSandboxResult,
} from "#shared/workflow-sandbox.js";
import {
  buildFinalOutputTool,
  FINAL_OUTPUT_TOOL_NAME,
} from "#runtime/framework-tools/final-output.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { RunMode } from "#shared/run-mode.js";
import type {
  CompactionConfig,
  HarnessSession,
  HarnessToolMap,
  StepFn,
  StepInput,
  StepResult,
  ToolLoopHarnessConfig,
} from "#harness/types.js";

/**
 * Creates a tool-loop harness step function backed by AI SDK `ToolLoopAgent`.
 */

/**
 * Builds the `telemetry` value for the AI SDK from authored settings.
 *
 * Custom context (authored `InstrumentationDefinition.events` plus
 * eve-specific identifiers such as `eve.session.id`) is flowed through
 * {@link buildTelemetryRuntimeContext} because AI SDK v7 surfaces
 * per-call attributes via `runtimeContext`, not a dedicated metadata field on
 * `TelemetryOptions`.
 */
const environment = process.env.NODE_ENV ?? "unknown";
const eveVersion = resolveInstalledPackageInfo().version;

const log = createLogger("harness.tool-loop");

/**
 * Wired as the agent's `onToolExecutionEnd`. On the `tool-error` branch
 * the `error` is still the original throwable (stack/cause intact),
 * unlike the message-only `tool-error` part the model later sees.
 */
function logToolExecutionError(event: {
  readonly toolCall: { readonly toolName: string; readonly toolCallId: string };
  readonly toolOutput: { readonly type: string; readonly error?: unknown };
}): void {
  if (event.toolOutput.type !== "tool-error") {
    return;
  }
  logError(log, "tool execution failed", event.toolOutput.error, {
    toolName: event.toolCall.toolName,
    toolCallId: event.toolCall.toolCallId,
  });
}

/**
 * Max attempts (1 original + N retries) for transient model-call
 * failures before the harness gives up and falls back to the
 * recoverable/terminal emission path. Kept small on purpose — every
 * attempt costs a round-trip plus prompt tokens, and the dominant
 * use case (429 / 502) clears quickly or not at all.
 */
const MODEL_CALL_MAX_ATTEMPTS = 3;

/**
 * Base delay (ms) between model-call retries. Doubled each attempt,
 * plus a small random jitter to avoid thundering-herd behavior when
 * a provider incident clears.
 */
const MODEL_CALL_RETRY_BASE_DELAY_MS = 500;

function enrichTelemetry(
  authored: InstrumentationDefinition | undefined,
  agentName: string | undefined,
  runtimeContext?: Readonly<Record<string, unknown>>,
): TelemetryOptions | undefined {
  if (authored === undefined) {
    return undefined;
  }

  // AI SDK telemetry redacts runtimeContext unless every exported key is
  // opted in. This context only contains sanitized instrumentation context.
  const includeRuntimeContext: Record<string, true> = {};
  for (const key of Object.keys(runtimeContext ?? {})) {
    includeRuntimeContext[key] = true;
  }

  return {
    functionId: authored.functionId ?? agentName,
    includeRuntimeContext,
    isEnabled: true,
    recordInputs: authored.recordInputs ?? true,
    recordOutputs: authored.recordOutputs ?? true,
  };
}

/**
 * Builds AI Gateway app attribution headers when the model is gateway-routed.
 *
 * Gateway routing is detected by `typeof model === "string"` — the same
 * condition used for the `gateway-auto` cache path. Returns `undefined`
 * for non-gateway models or when no meaningful attribution is available.
 */
function buildGatewayAttributionHeaders(
  model: LanguageModel,
  runtimeIdentity: ToolLoopHarnessConfig["runtimeIdentity"],
): Record<string, string> | undefined {
  if (typeof model !== "string") {
    return undefined;
  }

  const title = runtimeIdentity?.agentName ?? runtimeIdentity?.agentId;
  const deploymentHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const referer = deploymentHost ? `https://${deploymentHost}` : undefined;

  if (!title && !referer) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  if (title) headers["x-title"] = title;
  if (referer) headers["http-referer"] = referer;
  return headers;
}

async function resolveActiveRuntimeModel(input: {
  readonly config: ToolLoopHarnessConfig;
  readonly ctx: ReturnType<typeof contextStorage.getStore>;
  readonly session: HarnessSession;
}): Promise<{
  readonly model: LanguageModel;
  readonly session: HarnessSession;
}> {
  if (input.ctx === undefined) {
    return {
      model: await input.config.resolveModel(input.session.agent.modelReference),
      session: input.session,
    };
  }

  const fallback =
    input.session.agent.dynamicModelDefaultReference ?? input.session.agent.modelReference;
  const selected = getActiveDynamicModelSelection(input.ctx);

  if (selected === null) {
    return {
      model: await input.config.resolveModel(fallback),
      session: updateSessionModelReference(input.session, fallback),
    };
  }

  return {
    model:
      selected.model !== undefined
        ? selected.model
        : await input.config.resolveModel(selected.reference),
    session: updateSessionModelReference(input.session, selected.reference),
  };
}

function updateSessionModelReference(
  session: HarnessSession,
  modelReference: RuntimeModelReference,
): HarnessSession {
  // Rescale from the reference the current threshold was computed against;
  // rescaling from the static fallback would compound the threshold per step.
  const priorReference = session.agent.modelReference;
  return {
    ...session,
    agent: {
      ...session.agent,
      modelReference,
    },
    compaction: updateCompactionThresholdForModelReference({
      compaction: session.compaction,
      modelReference,
      priorReference,
    }),
  };
}

function updateCompactionThresholdForModelReference(input: {
  readonly compaction: CompactionConfig;
  readonly modelReference: RuntimeModelReference;
  readonly priorReference: RuntimeModelReference;
}): CompactionConfig {
  if (
    input.modelReference.contextWindowTokens === undefined ||
    input.priorReference.contextWindowTokens === undefined
  ) {
    return input.compaction;
  }

  const thresholdPercent = input.compaction.threshold / input.priorReference.contextWindowTokens;
  return {
    ...input.compaction,
    threshold: Math.max(1, Math.floor(input.modelReference.contextWindowTokens * thresholdPercent)),
  };
}

// ---------------------------------------------------------------------------
// Turn trace state — survives step boundaries via session.state
// ---------------------------------------------------------------------------

const TURN_TRACE_STATE_KEY = "eve.harness.turnTrace";

/**
 * Serializable subset of `SpanContext` stored on `session.state` so
 * continuation steps within the same turn can restore the parent trace.
 */
interface TurnTraceState {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

function getTurnTraceState(session: {
  readonly state?: Readonly<Record<string, unknown>>;
}): TurnTraceState | undefined {
  return session.state?.[TURN_TRACE_STATE_KEY] as TurnTraceState | undefined;
}

function setTurnTraceState(session: HarnessSession, spanContext: SpanContext): HarnessSession {
  const stored: TurnTraceState = {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
  };

  return {
    ...session,
    state: {
      ...session.state,
      [TURN_TRACE_STATE_KEY]: stored,
    },
  };
}

/**
 * Resolves the OTel context for the current step.
 *
 * First step of a turn: uses the newly created turn span.
 * Continuation steps: restores the parent span context from session state
 * so AI SDK spans nest under the same trace as the first step.
 */
function resolveStepOtelContext(
  tracer: ReturnType<typeof trace.getTracer> | undefined,
  turnSpan: Span | undefined,
  session: { readonly state?: Readonly<Record<string, unknown>> },
): ReturnType<typeof otelContext.active> | undefined {
  if (turnSpan) {
    return trace.setSpan(otelContext.active(), turnSpan);
  }

  if (tracer) {
    const stored = getTurnTraceState(session);
    if (stored) {
      const parent = trace.wrapSpanContext({
        traceId: stored.traceId,
        spanId: stored.spanId,
        traceFlags: stored.traceFlags,
      });
      return trace.setSpan(otelContext.active(), parent);
    }
  }

  return undefined;
}

export function createToolLoopHarness(config: ToolLoopHarnessConfig): StepFn {
  const emit = config.handleEvent;
  const telemetryConfig = getInstrumentationConfig();
  if (telemetryConfig !== undefined) {
    ensureOtelIntegration();
  }
  const tracer = telemetryConfig !== undefined ? trace.getTracer("eve") : undefined;
  const agentName = config.runtimeIdentity?.agentName;

  async function runStep(
    initialSession: Readonly<Parameters<StepFn>[0]>,
    input?: StepInput,
  ): Promise<StepResult> {
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
    initialSession: Readonly<Parameters<StepFn>[0]>,
    input?: StepInput,
    turnSpan?: Span,
  ): Promise<StepResult> {
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
      return { next: null, session: resolvedRuntimeActions.session };
    }
    session = resolvedRuntimeActions.session;

    const pending = resolvePendingInput({
      history: resolvedRuntimeActions.messages,
      resolveApprovalKey: resolveApprovalKeyFromTools(config.tools),
      session,
      stepInput: stepInput.input,
    });
    if (pending.outcome === "unresolved") {
      if (emit && pending.deferredMessage === true && hasStepInput(input)) {
        emissionState = await emitTurnPreamble(
          emit,
          input ?? {},
          emissionState,
          config.runtimeIdentity,
        );
        emissionState = await emitTurnEpilogue(emit, emissionState, config.mode);
        return {
          next: null,
          session: setHarnessEmissionState(pending.session, emissionState),
        };
      }

      return { next: null, session: pending.session };
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
        input ?? {},
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

    if (stepInput.input?.context !== undefined) {
      for (const entry of stepInput.input.context) {
        messages.push({ content: entry, role: "user" });
      }
    }

    if (
      stepInput.input?.message !== undefined &&
      !pending.deferredMessage &&
      !pending.consumedMessage
    ) {
      // Staging writes FilePart bytes into the sandbox and replaces
      // each part's `data` with a compact `eve-sandbox:` URL. The
      // `messages` array — and everything that flows into
      // `session.history` from it — therefore never carries raw
      // attachment bytes across step boundaries.
      const content = await stageAttachmentsToSandbox(stepInput.input.message);
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
      headers: attributionHeaders,
      messages,
      model,
      onCompaction: config.onCompaction,
      resolveModel: config.resolveModel,
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

    const prepareModelCallInput = (extraSystemNote?: string) => {
      const extraSystemEntry: SystemModelMessage[] = extraSystemNote
        ? [{ role: "system" as const, content: extraSystemNote }]
        : [];
      const baseSystemEntry: SystemModelMessage[] = session.agent.system
        ? [{ role: "system" as const, content: session.agent.system }]
        : [];
      const rawInstructions =
        systemMessages.length > 0 || extraSystemEntry.length > 0
          ? [...extraSystemEntry, ...baseSystemEntry, ...systemMessages]
          : undefined;
      const instructions =
        rawInstructions !== undefined && marker
          ? applySystemCacheBreakpoint(rawInstructions, marker)
          : (rawInstructions ?? session.agent.system ?? undefined);

      return {
        instructions,
        telemetryRuntimeContext: buildTelemetryRuntimeContext({
          eveVersion,
          authored: telemetryConfig,
          emissionState,
          environment,
          modelInput: {
            instructions,
            messages: modelMessages,
          },
          session,
        }),
      };
    };

    /**
     * Assembles the effective toolset and ToolLoopAgent for one attempt
     * of this step, then runs the model call.
     *
     * Re-invoked by both recovery stages. The unsupported-provider-tool
     * retry passes `disabledProviderTools` to drop the offending tool and
     * `extraSystemNote` to tell the model why a capability was removed.
     * The empty-response reissue passes `retryReason` to label the retried
     * call's telemetry.
     */
    const runOneModelCall = async (opts: {
      disabledProviderTools?: ReadonlySet<string>;
      extraSystemNote?: string;
      preparedInput?: ReturnType<typeof prepareModelCallInput>;
      retryReason?: "empty-response";
      suppressStepStartedEmission?: boolean;
      trailingUserNote?: string;
    }): Promise<HarnessStepResult> => {
      const { instructions, telemetryRuntimeContext = {} } =
        opts.preparedInput ?? prepareModelCallInput(opts.extraSystemNote);
      // Label the reissued call's telemetry; without this a retry is only
      // visible as a second LLM span under one step.
      if (opts.retryReason) {
        telemetryRuntimeContext["eve.retry.reason"] = opts.retryReason;
      }
      // Trailing rather than an extraSystemNote prepend: keeps the provider's
      // cached prompt prefix valid, and handleStepResult rebuilds history
      // from the step's prompt messages, so the note exists only on this
      // call's wire request.
      const callMessages = opts.trailingUserNote
        ? [...modelMessages, { role: "user" as const, content: opts.trailingUserNote }]
        : modelMessages;
      const advertisedHarnessTools = getAdvertisedTools({
        session,
        tools: config.tools,
      });

      const flatTools = await buildToolSetWithProviderTools({
        approvedTools,
        capabilities: config.capabilities,
        disabledProviderTools: opts.disabledProviderTools,
        modelReference: session.agent.modelReference,
        tools: advertisedHarnessTools,
      });

      if (ctx !== undefined) {
        const dynamicTools = getAdvertisedTools({
          session,
          tools: buildDynamicTools(ctx),
        });
        const dynamicToolSet = buildToolSetFromDefinitions({
          approvedTools,
          capabilities: config.capabilities,
          disabledProviderTools: opts.disabledProviderTools,
          tools: dynamicTools,
        });
        // Dynamic tools override a same-named authored tool.
        for (const [name, toolDefinition] of Object.entries(dynamicToolSet)) {
          flatTools[name] = toolDefinition;
        }
      }

      if (session.outputSchema !== undefined) {
        flatTools[FINAL_OUTPUT_TOOL_NAME] = buildFinalOutputTool(session.outputSchema);
      }

      const workflowLifecycle =
        emit !== undefined
          ? ({ tools }: { readonly tools: HarnessToolMap }) =>
              createWorkflowLifecycle({
                emit,
                emissionState,
                tools,
              })
          : undefined;
      const workflowConfig =
        config.workflow === true
          ? { lifecycle: workflowLifecycle, maxSubagents: config.workflowMaxSubagents }
          : undefined;

      const advertisedModelTools = await getAdvertisedTools({
        modelTools: flatTools,
        session,
        tools: advertisedHarnessTools,
        workflow: workflowConfig,
      });
      session = advertisedModelTools.session;
      const modelTools = advertisedModelTools.modelTools;

      const effectiveTools = marker ? applyLastToolCacheBreakpoint(modelTools, marker) : modelTools;

      const hooks = buildStepHooks({
        cachePath,
        emit,
        emissionState,
        emitStepStarted: opts.suppressStepStartedEmission !== true,
        marker,
        session,
      });

      const agentSettings = {
        headers: attributionHeaders,
        instructions,
        model,
        onToolExecutionEnd: logToolExecutionError,
        // Replaces the AI SDK's default `console.error`; the harness still
        // emits stream events, this just keeps the raw error from being silent.
        onError(event: { error: unknown }) {
          // Recognized configuration failures (gateway auth, missing API key)
          // skip the raw inspector dump — its stack points at the harness, not
          // the fix, and the terminal-failure path logs the one-line summary
          // and emits the structured step.failed. Unrecognized errors keep
          // the full dump so they stay loud.
          if (summarizeKnownModelCallConfigError(event.error) !== null) return;
          logError(log, "tool-loop stream error", event.error);
        },
        onStepFinish: hooks.onStepFinish,
        prepareStep: hooks.prepareStep,
        reasoning: session.agent.reasoning,
        runtimeContext: telemetryRuntimeContext,
        stopWhen: isStepCount(1),
        telemetry: enrichTelemetry(telemetryConfig, agentName, telemetryRuntimeContext),
        toolApproval: buildToolApproval(modelTools),
        tools: effectiveTools,
      };
      const agent = new ToolLoopAgent(agentSettings);

      const executeModelCall = async (): Promise<HarnessStepResult> => {
        if (emit) {
          const hiddenRuntimeActionToolNames = [...config.tools]
            .filter(
              ([name, tool]) =>
                tool.runtimeAction !== undefined && advertisedHarnessTools.get(name) === undefined,
            )
            .map(([name]) => name);
          const excludedActionToolNames = new Set([
            ASK_QUESTION_TOOL_NAME,
            FINAL_OUTPUT_TOOL_NAME,
            ...hiddenRuntimeActionToolNames,
          ]);
          const streamResult = await agent.stream({
            abortSignal: config.abortSignal,
            messages: callMessages,
          });
          const {
            emittedActionCallIds,
            handledInlineToolResultCallIds,
            invalidInputToolCallIds,
            inlineAuthorizationResults,
            inlineToolResultParts,
            trailingInlineToolResultParts,
          } = await emitStreamContent(emit, emissionState, streamResult.fullStream, {
            excludedActionToolNames,
            tools: config.tools,
          });
          throwIfTurnAborted(config.abortSignal);
          const stepResult = await hooks.stepResult;
          if (
            isEmptyModelResponse(stepResult) &&
            inlineToolResultParts.length === 0 &&
            inlineAuthorizationResults.length === 0 &&
            trailingInlineToolResultParts.length === 0
          ) {
            throw new EmptyModelResponseError();
          }
          await emitStepActions(emit, emissionState, stepResult, {
            emittedActionCallIds,
            excludedActionCallIds: invalidInputToolCallIds,
            excludedActionToolNames,
            handledInlineToolResultCallIds,
            tools: advertisedHarnessTools,
          });
          if (
            inlineToolResultParts.length > 0 ||
            inlineAuthorizationResults.length > 0 ||
            trailingInlineToolResultParts.length > 0
          ) {
            const existingToolResults = stepResult.toolResults as TypedToolResult<ToolSet>[];
            const toolResultsByCallId = new Map(
              existingToolResults.map((toolResult) => [toolResult.toolCallId, toolResult]),
            );
            for (const toolResult of inlineAuthorizationResults) {
              toolResultsByCallId.set(toolResult.toolCallId, toolResult);
            }
            /*
             * AI SDK `StepResult` is a class whose `content`,
             * `toolCalls`, `toolResults`, and `text` are prototype
             * getters. Each field is read explicitly here rather than via
             * spread so the returned plain object carries the values —
             * spread would copy only own enumerable properties and the
             * downstream `extractQuestionInputRequests` would crash on
             * `toolCalls === undefined`.
             */
            return {
              content: stepResult.content,
              finishReason: stepResult.finishReason,
              response: {
                ...stepResult.response,
                ...(inlineToolResultParts.length > 0 || trailingInlineToolResultParts.length > 0
                  ? {
                      messages: insertInlineToolResultMessages({
                        append: trailingInlineToolResultParts,
                        prepend: inlineToolResultParts,
                        responseMessages: stepResult.response.messages,
                      }),
                    }
                  : {}),
              },
              providerMetadata: stepResult.providerMetadata,
              text: stepResult.text,
              toolCalls: stepResult.toolCalls,
              toolResults: [...toolResultsByCallId.values()],
              invalidInputToolCallIds,
              usage: stepResult.usage,
            };
          }
          return stepResult;
        }
        await agent.generate({ abortSignal: config.abortSignal, messages: callMessages });
        throwIfTurnAborted(config.abortSignal);
        const stepResult = await hooks.stepResult;
        if (isEmptyModelResponse(stepResult)) {
          throw new EmptyModelResponseError();
        }
        return stepResult;
      };

      return runModelCallWithRetries(
        () => executeModelCall().catch(rethrowNoOutputAsEmptyResponse),
        {
          sessionId: session.sessionId,
          turnId: emissionState.turnId,
        },
        config.abortSignal,
      );
    };

    // Resolve first-attempt instrumentation before step.started dispatch
    // allows dynamic tool resolvers to update the effective toolset.
    const initialModelCallInput = prepareModelCallInput();

    // Emit step.started before building the toolset so dynamic tool
    // resolvers subscribed to step.started write to LiveStepToolsKey.
    if (emit) {
      await emitStepStarted(emit, emissionState, messages);
    }

    // Workflow continuations replay the sandbox after step.started so nested
    // action lifecycle events keep the active turn's emission coordinates.
    const pendingWorkflowInterrupt = await continuePendingWorkflowInterrupt({
      childResults: stepInput.input?.runtimeActionResults,
      config,
      emit,
      emissionState,
      runStep,
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
      result = await runOneModelCall({
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
              runOneModelCall,
              sessionId: session.sessionId,
              turnId: emissionState.turnId,
            }),
          (current) =>
            attemptEmptyResponseRecovery({
              emptyDeliveryEnabled,
              error: current.error,
              retryCallOptions: current.retryCallOptions,
              runOneModelCall,
              sessionId: session.sessionId,
              turnId: emissionState.turnId,
            }),
        ],
      });
      throwIfTurnAborted(config.abortSignal);

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
            details: { ...streamWriteDetails, errorId },
            message: toErrorMessage(finalError),
          });
          const parkedSession = setHarnessEmissionState(session, emissionState);
          return { next: null, session: parkedSession };
        }

        const classification = classifyModelCallError(finalError);
        const errorId = createErrorId();
        const configSummary =
          classification === "terminal" ? summarizeKnownModelCallConfigError(finalError) : null;
        const requestSummary =
          configSummary === null ? summarizeKnownModelCallRequestError(finalError) : null;
        const errorMessage =
          configSummary?.message ?? requestSummary?.message ?? toErrorMessage(finalError);
        const modelCallDetails = extractModelCallErrorDetails(finalError);
        const details = buildModelCallFailureDetails({
          configSummary,
          error: finalError,
          errorId,
          modelCallDetails,
          requestSummary,
        });
        const modelCallLogFields = buildModelCallFailureLogFields({
          error: finalError,
          errorId,
          modelCallDetails,
          requestSummary,
          sessionId: session.sessionId,
          turnId: emissionState.turnId,
        });

        if (classification === "terminal") {
          if (configSummary !== null) {
            // Recognized configuration failure: log a concise single line
            // and skip the structured SDK dump so the user sees an
            // actionable hint instead of a wall of inspector output.
            log.error(`${configSummary.name}: ${configSummary.message}`, {
              errorId,
              sessionId: session.sessionId,
              turnId: emissionState.turnId,
            });
          } else {
            log.error(
              requestSummary?.message ?? "model call failed terminally",
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
          return {
            next:
              config.mode === "task"
                ? { done: true, isError: true, output: errorMessage }
                : { done: true, output: "" },
            session,
          };
        }

        if (config.mode === "task") {
          // A task run cannot park for a user retry (turnWorkflow rejects
          // `next: null` in task mode), so the failure is the task's
          // terminal result, mirroring finishTaskTurn's unfulfilled-schema
          // shape.
          log.error(
            requestSummary?.message ?? "model call failed; failing the task run",
            modelCallLogFields,
          );
          await emitFailedStep(emit, emissionState, {
            code: "MODEL_CALL_FAILED",
            details,
            message: errorMessage,
            sessionId: session.sessionId,
          });
          return {
            next: { done: true, isError: true, output: errorMessage },
            session,
          };
        }

        log.error(
          requestSummary?.message ?? "model call failed — parking session for retry by the user",
          modelCallLogFields,
        );
        emissionState = await emitRecoverableFailedTurn(emit, emissionState, {
          code: "MODEL_CALL_FAILED",
          details,
          message: errorMessage,
        });
        const parkedSession = setHarnessEmissionState(session, emissionState);
        return { next: null, session: parkedSession };
      }
    }

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
    // Best-effort: `setEveAttributes` swallows runtime failures so a
    // broken tag emit can never break the agent loop.
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
    // becomes `undefined` and is dropped by `setEveAttributes` instead of
    // throwing into the tool loop.
    let modelTag: string | undefined;
    try {
      modelTag = formatLanguageModelGatewayId(model);
    } catch {
      modelTag = undefined;
    }
    await setEveAttributes({
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
      runStep,
      session,
    });
  }

  return runStep;
}

function extractTokenUsageDelta(input: {
  readonly costUsd: number | undefined;
  readonly usage: HarnessStepResult["usage"] | undefined;
}): TokenUsageDelta | undefined {
  const usage = input.usage;
  if (usage === undefined && input.costUsd === undefined) {
    return undefined;
  }

  return {
    cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens,
    costUsd: input.costUsd,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
  };
}

function extractGatewayCostUsd(providerMetadata: ProviderMetadata | undefined): number | undefined {
  const gateway = readGatewayMetadata(providerMetadata);
  const cost = gateway?.cost;
  if (typeof cost === "number" && Number.isFinite(cost)) {
    return cost;
  }
  if (typeof cost === "string") {
    const parsed = Number(cost);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readGatewayMetadata(
  providerMetadata: ProviderMetadata | undefined,
): ProviderMetadata[string] | undefined {
  const gateway = providerMetadata?.gateway;
  return gateway && typeof gateway === "object" && !Array.isArray(gateway) ? gateway : undefined;
}

// ---------------------------------------------------------------------------
// Model-call failure projection
// ---------------------------------------------------------------------------

/**
 * Projects a model-call failure into the `step.failed` / `turn.failed`
 * `details` payload. Three mutually exclusive branches:
 *
 * 1. Config summary (known terminal: missing key, gateway auth)  → friendly
 *    `name` + `message`, no SDK inspector dump.
 * 2. Request summary (ambiguous gateway 4xx that we recover from) → raw
 *    error `message`, friendly `name`, no inspector dump.
 * 3. Fallback → full {@link formatError} projection (cause chain via
 *    `util.inspect`) so unrecognized failures still carry the upstream
 *    stack to log aggregators.
 *
 * All branches merge {@link extractModelCallErrorDetails} on top so the
 * compact gateway diagnostics (`statusCode`, `upstreamMessage`,
 * `responseBodySnippet`, ...) always show up next to the message.
 */
function buildModelCallFailureDetails(input: {
  readonly configSummary: ModelCallConfigErrorSummary | null;
  readonly error: unknown;
  readonly errorId: string;
  readonly modelCallDetails: JsonObject;
  readonly requestSummary: ModelCallConfigErrorSummary | null;
}): JsonObject {
  const { configSummary, error, errorId, modelCallDetails, requestSummary } = input;

  if (configSummary !== null) {
    return {
      errorId,
      message: configSummary.message,
      name: configSummary.name,
      ...modelCallDetails,
    };
  }

  if (requestSummary !== null) {
    return {
      errorId,
      message: toErrorMessage(error),
      name: requestSummary.name,
      ...modelCallDetails,
    };
  }

  return { ...formatError(error, errorId), ...modelCallDetails };
}

/**
 * Builds the structured log fields for a model-call failure. When we
 * recognized the failure as an ambiguous gateway request rejection, attach
 * the compact `details` payload and *omit* the raw `error` so the logger's
 * `util.inspect` of the cause chain (which would render `[object Object]`
 * for upstream `APICallError` shapes) is bypassed. Otherwise fall back to
 * the raw error so unrecognized failures keep their full stack in logs.
 */
function buildModelCallFailureLogFields(input: {
  readonly error: unknown;
  readonly errorId: string;
  readonly modelCallDetails: JsonObject;
  readonly requestSummary: ModelCallConfigErrorSummary | null;
  readonly sessionId: string;
  readonly turnId: string;
}): Record<string, unknown> {
  const base = {
    errorId: input.errorId,
    sessionId: input.sessionId,
    turnId: input.turnId,
  };
  if (input.requestSummary !== null) {
    return { ...base, details: input.modelCallDetails };
  }
  return { ...base, error: input.error };
}

// ---------------------------------------------------------------------------
// Unsupported provider tool recovery
// ---------------------------------------------------------------------------

/**
 * Call options a failing recovery retry used. A subsequent recovery
 * repeats the same call shape instead of silently restoring state the
 * earlier recovery removed (e.g. a provider tool the gateway rejected).
 */
type RecoveryRetryCallOptions = {
  readonly disabledProviderTools?: ReadonlySet<string>;
  readonly extraSystemNote?: string;
};

/**
 * The slice of `runOneModelCall` a recovery stage may use for its retry.
 */
type RecoveryModelCallFn = (
  opts: RecoveryRetryCallOptions & {
    readonly retryReason?: "empty-response";
    readonly suppressStepStartedEmission?: boolean;
    readonly trailingUserNote?: string;
  },
) => Promise<HarnessStepResult>;

/**
 * Shared arms of a recovery outcome, and what
 * {@link runModelCallRecoveryPipeline} resolves to.
 *
 * - `recovered`: the retry call succeeded and the wrapped result should
 *   flow into the normal post-step handling.
 * - `failed`: the recovery acted and its retry also failed. The wrapped
 *   error replaces the current error; `retryCallOptions`, when present,
 *   is the call shape the failing retry used.
 */
type ModelCallRecoveryBase =
  | { readonly outcome: "recovered"; readonly result: HarnessStepResult }
  | {
      readonly outcome: "failed";
      readonly error: unknown;
      readonly retryCallOptions?: RecoveryRetryCallOptions;
    };

/**
 * Outcome of a single recovery stage
 * ({@link attemptUnsupportedProviderToolRecovery},
 * {@link attemptEmptyResponseRecovery}): the shared arms plus `skipped`,
 * returned when the error does not match the stage's trigger so the
 * pipeline passes the current error on unchanged.
 */
type ModelCallRecoveryResult = ModelCallRecoveryBase | { readonly outcome: "skipped" };

/**
 * One stage of {@link runModelCallRecoveryPipeline}: receives the current
 * error plus the call shape of the previous stage's failing retry.
 */
type ModelCallRecoveryStage = (current: {
  readonly error: unknown;
  readonly retryCallOptions?: RecoveryRetryCallOptions;
}) => Promise<ModelCallRecoveryResult>;

/**
 * Runs the model-call recovery stages in order against the current error.
 *
 * Each stage checks its own trigger and returns `skipped` for errors it
 * does not handle, leaving the current error for the next stage. A stage
 * that acts either ends the pipeline with `recovered` or replaces the
 * current error with its retry's failure, so a later stage can match the
 * transformed error (a tool-drop retry can itself come back empty). The
 * trigger check stays inside the stage because it can be multi-phase: the
 * tool recovery also skips when no rejected type maps to a known framework
 * tool. `retryCallOptions` carries the failing retry's call shape to the
 * next stage so a reissue repeats what that retry sent.
 */
async function runModelCallRecoveryPipeline(input: {
  readonly error: unknown;
  readonly stages: readonly ModelCallRecoveryStage[];
}): Promise<ModelCallRecoveryBase> {
  let error = input.error;
  let retryCallOptions: RecoveryRetryCallOptions | undefined;
  for (const stage of input.stages) {
    const outcome = await stage({ error, retryCallOptions });
    if (outcome.outcome === "recovered") {
      return outcome;
    }
    if (outcome.outcome === "failed") {
      error = outcome.error;
      retryCallOptions = outcome.retryCallOptions;
    }
  }
  return { outcome: "failed", error };
}

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;
type StepResponseMessage = HarnessStepResult["response"]["messages"][number];

function insertInlineToolResultMessages(input: {
  readonly append: readonly ToolResultPart[];
  readonly prepend: readonly ToolResultPart[];
  readonly responseMessages: readonly StepResponseMessage[];
}): StepResponseMessage[] {
  const existingCallIds = extractToolResultCallIds(input.responseMessages);
  const prepend = input.prepend.filter((part) => !existingCallIds.has(part.toolCallId));
  const append = input.append.filter((part) => !existingCallIds.has(part.toolCallId));

  return [
    ...(prepend.length > 0 ? [{ role: "tool" as const, content: [...prepend] }] : []),
    ...input.responseMessages,
    ...(append.length > 0 ? [{ role: "tool" as const, content: [...append] }] : []),
  ] satisfies StepResponseMessage[];
}

function getInvalidToolCallInputErrors(input: {
  readonly toolCalls: readonly TypedToolCall<ToolSet>[];
}): readonly TypedToolError<ToolSet>[] {
  const errors: TypedToolError<ToolSet>[] = [];

  for (const toolCall of input.toolCalls) {
    if (toolCall.toolName === FINAL_OUTPUT_TOOL_NAME) {
      continue;
    }

    const toolError = getInvalidToolCallInputError({ toolCall });
    if (toolError !== undefined) {
      errors.push(toolError);
    }
  }

  return errors;
}

function extractToolResultCallIds(messages: readonly StepResponseMessage[]): ReadonlySet<string> {
  const callIds = new Set<string>();

  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (part.type === "tool-result") {
        callIds.add(part.toolCallId);
      }
    }
  }

  return callIds;
}

/**
 * Inspects a model-call failure for the "tool type 'X' is not supported"
 * provider-attempt rejection that AI Gateway returns when a fallback
 * provider cannot serve a provider-specific tool. On a match, retries the
 * step once with the offending tool dropped and a one-shot system note
 * telling the model which capability has been removed.
 *
 * Returns `recovered` when the retry succeeded so the caller can hand
 * the result off to the usual post-step handler. Returns `failed`
 * (with the original error, or the retry's error if the retry also
 * threw) otherwise so the caller's existing terminal/recoverable
 * cascade still runs.
 *
 * Recovery is intentionally scoped to known provider tools — entries in
 * {@link UPSTREAM_TOOL_TYPE_TO_FRAMEWORK_NAME} — so an unrelated
 * upstream rejection cannot accidentally drop a user-authored tool.
 */
async function attemptUnsupportedProviderToolRecovery(input: {
  readonly error: unknown;
  readonly runOneModelCall: RecoveryModelCallFn;
  readonly sessionId: string;
  readonly turnId: string;
}): Promise<ModelCallRecoveryResult> {
  const unsupportedTypes = extractUnsupportedProviderToolTypes(input.error);
  if (unsupportedTypes.length === 0) {
    return { outcome: "skipped" };
  }

  const toolsToDisable: string[] = [];
  for (const type of unsupportedTypes) {
    const frameworkName = resolveFrameworkToolFromUpstreamType(type);
    if (frameworkName !== null && !toolsToDisable.includes(frameworkName)) {
      toolsToDisable.push(frameworkName);
    }
  }

  if (toolsToDisable.length === 0) {
    return { outcome: "skipped" };
  }

  log.warn("disabling unsupported provider tool(s); retrying step once", {
    disabled: toolsToDisable,
    sessionId: input.sessionId,
    turnId: input.turnId,
    upstreamTypes: unsupportedTypes,
  });

  const retryCallOptions: RecoveryRetryCallOptions = {
    disabledProviderTools: new Set(toolsToDisable),
    extraSystemNote: buildDisabledToolNote(toolsToDisable),
  };
  try {
    const result = await input.runOneModelCall({
      ...retryCallOptions,
      suppressStepStartedEmission: true,
    });
    return { outcome: "recovered", result };
  } catch (retryError) {
    return { outcome: "failed", error: retryError, retryCallOptions };
  }
}

/**
 * Builds the one-shot system note prepended to the recovery retry's
 * instructions so the model has explicit context for why a capability
 * disappeared mid-turn.
 */
function buildDisabledToolNote(toolNames: readonly string[]): string {
  const list = toolNames.join(", ");
  const noun = toolNames.length === 1 ? "tool is" : "tools are";
  return (
    `The following ${noun} not available with the current model and ` +
    `has been removed: ${list}. Proceed using the remaining tools or your ` +
    `training knowledge.`
  );
}

/**
 * True when a step produced no assistant text and no tool calls. Intentional
 * silence uses {@link EMPTY_DELIVERY_SENTINEL}; a genuinely blank response is
 * ambiguous and must be retried instead of silently dropping a HITL reply.
 */
function isEmptyModelResponse(step: HarnessStepResult): boolean {
  return (
    step.toolCalls.length === 0 &&
    step.toolResults.length === 0 &&
    resolveAssistantStepText(step.response.messages, step.text) === null
  );
}

/**
 * Rethrows the AI SDK's `NoOutputGeneratedError` as
 * {@link EmptyModelResponseError}. Since `ai@7.0.0-canary.169`
 * (vercel/ai#15938) a stream that closes after metadata without output or
 * a finish chunk rejects — the SDK enqueues the error onto `fullStream`
 * (so `emitStreamContent` throws it) and never emits `finish-step`, so
 * `onStepFinish` does not fire and the step hooks' `stepResult` promise
 * would never settle. The same condition previously completed as an empty
 * step caught by {@link isEmptyModelResponse}; normalizing here funnels
 * both shapes into the one-shot empty-response reissue.
 */
function rethrowNoOutputAsEmptyResponse(error: unknown): never {
  if (isNoOutputGeneratedError(error)) {
    throw new EmptyModelResponseError({ cause: error });
  }
  throw error;
}

/**
 * Wire-only note the empty-response reissue appends to its retry, so the
 * model answers from the tool results already in context instead of
 * re-exploring. Each recovery stage declares its own follow-up text: the
 * tool recovery prepends {@link buildDisabledToolNote} as a system note
 * (its toolset change busts the prompt cache anyway), this one trails as
 * a user note to keep the cached prefix valid.
 */
const EMPTY_RESPONSE_NUDGE =
  "Your previous reply was empty and was not delivered. Answer now from the tool results above; do not re-run tools or mention this notice.";

function buildEmptyResponseNudge(emptyDeliveryEnabled: boolean): string {
  if (!emptyDeliveryEnabled) {
    return EMPTY_RESPONSE_NUDGE;
  }
  return `${EMPTY_RESPONSE_NUDGE} If the current task explicitly requires conditional delivery and there is nothing to report, reply with exactly ${EMPTY_DELIVERY_SENTINEL}.`;
}

/**
 * Recovers a model call that completed without content (see
 * {@link EmptyModelResponseError}) by reissuing the same call once, with
 * {@link EMPTY_RESPONSE_NUDGE} appended to the wire request. If the
 * reissue also fails, the caller's failure floor takes over.
 *
 * The reissue goes through `runOneModelCall` so it gets fresh step hooks;
 * the previous attempt's one-shot `stepResult` promise has already resolved
 * and would feed a same-hooks retry the stale empty result. The reissue
 * stays within the current step: the empty attempt emitted no step.completed
 * (an approval-resume step may have surfaced inline action results before
 * the throw), and `suppressStepStartedEmission` avoids a duplicate
 * step.started. When the empty response came from another recovery's retry,
 * `retryCallOptions` repeats that call's shape so the reissue does not
 * restore what the earlier recovery removed.
 */
async function attemptEmptyResponseRecovery(input: {
  readonly emptyDeliveryEnabled: boolean;
  readonly error: unknown;
  readonly retryCallOptions?: RecoveryRetryCallOptions;
  readonly runOneModelCall: RecoveryModelCallFn;
  readonly sessionId: string;
  readonly turnId: string;
}): Promise<ModelCallRecoveryResult> {
  if (!(input.error instanceof EmptyModelResponseError)) {
    return { outcome: "skipped" };
  }

  log.warn("empty model response; reissuing the model call once", {
    sessionId: input.sessionId,
    turnId: input.turnId,
  });

  try {
    const result = await input.runOneModelCall({
      ...input.retryCallOptions,
      retryReason: "empty-response",
      suppressStepStartedEmission: true,
      trailingUserNote: buildEmptyResponseNudge(input.emptyDeliveryEnabled),
    });
    return { outcome: "recovered", result };
  } catch (retryError) {
    return { outcome: "failed", error: retryError, retryCallOptions: input.retryCallOptions };
  }
}

// ---------------------------------------------------------------------------
// Post-step result handling
// ---------------------------------------------------------------------------

/**
 * Processes the step result: extracts input requests, decides whether to
 * park, continue the tool loop, or terminate.
 */
async function handleStepResult(input: {
  readonly config: ToolLoopHarnessConfig;
  readonly emit?: ToolLoopHarnessConfig["handleEvent"];
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly promptMessages: readonly ModelMessage[];
  readonly result: HarnessStepResult;
  readonly runStep: StepFn;
  readonly session: HarnessSession;
}): Promise<StepResult> {
  const { config, emit, promptMessages, result, runStep } = input;
  let { emissionState, session } = input;

  const resolvedStepOutput = resolveAssistantStepText(result.response.messages, result.text);
  const emptyDelivery =
    result.finishReason !== "tool-calls" &&
    result.toolCalls.length === 0 &&
    hasEmptyDeliverySentinel(resolvedStepOutput);
  const invalidInputToolErrors = getInvalidToolCallInputErrors({
    toolCalls: result.toolCalls as TypedToolCall<ToolSet>[],
  });
  const invalidInputToolCallIds = new Set([
    ...(result.invalidInputToolCallIds ?? []),
    ...invalidInputToolErrors.map((toolError) => toolError.toolCallId),
  ]);
  const rawResponseMessages = emptyDelivery
    ? []
    : insertInlineToolResultMessages({
        append: invalidInputToolErrors.map((toolError) =>
          createToolResultMessagePartFromToolError(toolError),
        ),
        prepend: [],
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
    .filter((toolCall) => !isInvalidToolCall(toolCall))
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
    return {
      next: null,
      session: setHarnessEmissionState(
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
    };
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
        emissionState = await emitTurnEpilogue(emit, emissionState, config.mode);
        parkedSession = setHarnessEmissionState(parkedSession, emissionState);
      }
    }

    return { next: null, session: parkedSession };
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

    return {
      next: null,
      session: setHarnessEmissionState(
        {
          ...baseSession,
          history: [...promptMessages],
          state: setPendingAuthorization(baseSession.state, { challenges }),
        },
        emissionState,
      ),
    };
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

    return { next: runStep, session: nextSession };
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

const OUTPUT_SCHEMA_NOT_FULFILLED = {
  code: "OUTPUT_SCHEMA_NOT_FULFILLED",
  message: "The agent could not produce a result matching the requested schema.",
} as const;

/**
 * The structured value the model delivered by calling the framework
 * `final_output` tool, or `undefined` when the terminal turn ended in prose.
 */
function extractFinalOutput(result: HarnessStepResult): JsonValue | undefined {
  return (result.toolCalls ?? []).find((call) => call.toolName === FINAL_OUTPUT_TOOL_NAME)
    ?.input as JsonValue | undefined;
}

/**
 * Persists the structured value as the assistant turn rather than the
 * un-executed `final_output` call, which would be a dangling tool_use on the
 * next turn. Clearing the run-scoped schema keeps it scoped to this turn.
 */
function persistStructuredAssistantTurn(
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

/** Emits `result.completed` followed by the turn epilogue for `mode`. */
async function emitStructuredResult(
  emit: NonNullable<ToolLoopHarnessConfig["handleEvent"]>,
  emissionState: ReturnType<typeof getHarnessEmissionState>,
  structured: JsonValue,
  mode: RunMode,
): Promise<ReturnType<typeof getHarnessEmissionState>> {
  await emit(
    createResultCompletedEvent({
      result: structured,
      sequence: emissionState.sequence,
      stepIndex: emissionState.stepIndex,
      turnId: emissionState.turnId,
    }),
  );
  return emitTurnEpilogue(emit, emissionState, mode);
}

/**
 * Closes a terminal task turn. Task runs cannot park, so an unmet output
 * schema fails as an error a delegating parent can surface; otherwise the
 * structured value — or the plain assistant text — is the run's output.
 */
async function finishTaskTurn(input: {
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly emit?: ToolLoopHarnessConfig["handleEvent"];
  readonly history: readonly ModelMessage[];
  readonly result: HarnessStepResult;
  readonly schema: JsonObject | undefined;
  readonly session: HarnessSession;
  readonly stepOutput: string | null;
}): Promise<StepResult> {
  const { emit, history, result, schema, stepOutput } = input;
  let { emissionState, session } = input;

  if (schema === undefined) {
    if (emit) {
      emissionState = await emitTurnEpilogue(emit, emissionState, "task");
      session = setHarnessEmissionState(session, emissionState);
    }
    return { next: { done: true, output: stepOutput ?? "" }, session };
  }

  const structured = extractFinalOutput(result);
  if (structured === undefined) {
    if (emit) {
      await emitFailedStep(emit, emissionState, {
        ...OUTPUT_SCHEMA_NOT_FULFILLED,
        sessionId: session.sessionId,
      });
    }
    return {
      next: { done: true, isError: true, output: OUTPUT_SCHEMA_NOT_FULFILLED.message },
      session,
    };
  }

  session = persistStructuredAssistantTurn(session, history, structured);
  if (emit) {
    emissionState = await emitStructuredResult(emit, emissionState, structured, "task");
    session = setHarnessEmissionState(session, emissionState);
  }
  return { next: { done: true, output: structured }, session };
}

/**
 * Closes a terminal conversation turn. Conversation runs may park, so an unmet
 * output schema parks recoverably; otherwise the structured value (or prose)
 * ends the turn and the session waits for the next message.
 */
async function finishConversationTurn(input: {
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly emit?: ToolLoopHarnessConfig["handleEvent"];
  readonly history: readonly ModelMessage[];
  readonly result: HarnessStepResult;
  readonly schema: JsonObject | undefined;
  readonly session: HarnessSession;
}): Promise<StepResult> {
  const { emit, history, result, schema } = input;
  let { emissionState, session } = input;

  if (schema === undefined) {
    if (emit) {
      emissionState = await emitTurnEpilogue(emit, emissionState, "conversation");
      session = setHarnessEmissionState(session, emissionState);
    }
    return { next: null, session };
  }

  const structured = extractFinalOutput(result);
  if (structured === undefined) {
    if (emit) {
      emissionState = await emitRecoverableFailedTurn(
        emit,
        emissionState,
        OUTPUT_SCHEMA_NOT_FULFILLED,
      );
      session = setHarnessEmissionState(session, emissionState);
    }
    return { next: null, session };
  }

  session = persistStructuredAssistantTurn(session, history, structured);
  if (emit) {
    emissionState = await emitStructuredResult(emit, emissionState, structured, "conversation");
    session = setHarnessEmissionState(session, emissionState);
  }
  return { next: null, session };
}

/** Replays a parked dynamic workflow with completed child-agent results. */
async function continuePendingWorkflowInterrupt(input: {
  readonly childResults?: readonly { readonly output?: unknown }[];
  readonly config: ToolLoopHarnessConfig;
  readonly emit?: ToolLoopHarnessConfig["handleEvent"];
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly runStep: StepFn;
  readonly session: HarnessSession;
}): Promise<StepResult | null> {
  const pending = getPendingWorkflowInterrupt(input.session.state);
  if (pending === undefined) return null;

  const interrupt = pending.interrupt;
  if (!isWorkflowRuntimeActionInterrupt(interrupt)) {
    throw new Error(`Unsupported Workflow interrupt kind "${interrupt.payload.kind}".`);
  }

  const lifecycle =
    input.emit === undefined
      ? undefined
      : createWorkflowLifecycle({
          emit: input.emit,
          emissionState: input.emissionState,
          skipReplayed: true,
          tools: input.config.tools,
        });
  const continuationSecurity = getWorkflowContinuationSecurity(input.session);

  let continuationOutput: unknown;
  try {
    const hostTools = buildWorkflowHostTools({
      tools: input.config.tools,
    });

    const childResults = input.childResults ?? [];
    let currentInterrupt = interrupt;
    let resultIndex = 0;
    // Promise.all can park several child calls together. Resolve one ledger
    // entry per replay until every supplied child result has been consumed.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      continuationOutput = await continueWorkflowSandboxInterrupt({
        continuationSecurity,
        interrupt: currentInterrupt,
        lifecycle,
        resolution: childResults[resultIndex]?.output,
        tools: hostTools,
      });
      const loopUnwrapped = await unwrapWorkflowSandboxResult(
        continuationOutput,
        continuationSecurity,
      );
      if (loopUnwrapped.status !== "interrupted") break;
      if (!isWorkflowRuntimeActionInterrupt(loopUnwrapped.interrupt)) break;
      if (resultIndex + 1 >= childResults.length) break;
      const nextInterrupt = getWorkflowRuntimeActionInterrupts(loopUnwrapped.interrupt)[0];
      if (nextInterrupt === undefined) {
        throw new Error("Workflow continuation contains no pending runtime-action interrupt.");
      }
      resultIndex++;
      currentInterrupt = nextInterrupt;
    }
  } catch (error) {
    logError(log, "Workflow interrupt continuation failed", error);
    continuationOutput = {
      error: "workflow_continuation_failed",
      message: toErrorMessage(error),
      retryable: false,
    };
  }

  const unwrapped = await unwrapWorkflowSandboxResult(continuationOutput, continuationSecurity);
  const finalOutput = unwrapped.status === "interrupted" ? unwrapped.interrupt : unwrapped.output;
  const baseMessages = [...input.session.history, ...pending.responseMessages];
  const replacedMessages = replaceWorkflowToolResult(
    baseMessages,
    (interrupt as { outerToolCallId?: string }).outerToolCallId,
    finalOutput,
  );

  let session = clearPendingWorkflowInterrupt({
    ...input.session,
    history: replacedMessages,
  });

  if (unwrapped.status === "interrupted") {
    if (!isWorkflowRuntimeActionInterrupt(unwrapped.interrupt)) {
      throw new Error(`Unsupported Workflow interrupt kind "${unwrapped.interrupt.payload.kind}".`);
    }
    const promptMessageCount = input.session.history.length;
    const promptMessages = replacedMessages.slice(0, promptMessageCount);
    const responseMessages = replacedMessages.slice(promptMessageCount);
    session = { ...session, history: promptMessages };
    return parkOnWorkflowInterrupt({
      baseSession: session,
      emissionState: input.emissionState,
      interrupt: unwrapped.interrupt,
      promptMessages,
      responseMessages,
    });
  }

  return { next: input.runStep, session };
}

function replaceWorkflowToolResult(
  messages: readonly ModelMessage[],
  outerToolCallId: string | undefined,
  output: unknown,
): ModelMessage[] {
  if (outerToolCallId === undefined) return [...messages];
  const outputValue =
    typeof output === "string"
      ? { type: "text" as const, value: output }
      : { type: "json" as const, value: output };
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    const content = (message.content as readonly { type: string; toolCallId?: string }[]).map(
      (part) => {
        if (part.type !== "tool-result" || part.toolCallId !== outerToolCallId) return part;
        return { ...part, output: outputValue };
      },
    );
    return { ...message, content };
  }) as ModelMessage[];
}

function parkOnWorkflowInterrupt(input: {
  readonly baseSession: HarnessSession;
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly interrupt: WorkflowSandboxInterrupt;
  readonly promptMessages: readonly ModelMessage[];
  readonly responseMessages: readonly ModelMessage[];
}): StepResult {
  const interrupt = getWorkflowRuntimeActionInterrupts(input.interrupt)[0];
  if (interrupt === undefined) {
    throw new Error("Workflow continuation contains no pending runtime-action interrupt.");
  }

  const baseSession: HarnessSession = {
    ...input.baseSession,
    history: [...input.promptMessages],
  };

  const parkedSession = setPendingWorkflowInterrupt({
    interrupt,
    responseMessages: input.responseMessages,
    session: baseSession,
  });

  return { next: null, session: setHarnessEmissionState(parkedSession, input.emissionState) };
}

function createNextCompactionConfig(
  current: CompactionConfig,
  promptMessages: readonly ModelMessage[],
  result: HarnessStepResult,
): CompactionConfig {
  const next: {
    lastKnownInputTokens?: number;
    lastKnownPromptMessageCount?: number;
    recentWindowSize: number;
    threshold: number;
  } = {
    recentWindowSize: current.recentWindowSize,
    threshold: current.threshold,
  };

  if (result.usage?.inputTokens !== undefined) {
    next.lastKnownInputTokens = result.usage.inputTokens;
    next.lastKnownPromptMessageCount = promptMessages.length;
  }

  return next;
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
  readonly emit?: ToolLoopHarnessConfig["handleEvent"];
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly headers?: Record<string, string>;
  readonly messages: ModelMessage[];
  readonly model: LanguageModel;
  readonly onCompaction?: ToolLoopHarnessConfig["onCompaction"];
  readonly resolveModel: ToolLoopHarnessConfig["resolveModel"];
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
    input.headers,
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

/**
 * Creates an approval-key resolver from the tool map. The resolver computes
 * compound keys at recording time instead of pre-computing and persisting
 * them on the pending batch.
 */
function resolveApprovalKeyFromTools(
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

/**
 * Retries `fn` with exponential backoff while the thrown error is
 * classified as `"retry"`. Rethrows the last error once attempts are
 * exhausted or the error is classified as something other than
 * transient.
 */
async function runModelCallWithRetries<T>(
  fn: () => Promise<T>,
  diag: { readonly sessionId: string; readonly turnId: string },
  abortSignal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    throwIfTurnAborted(abortSignal);
    try {
      return await fn();
    } catch (error) {
      throwIfTurnAborted(abortSignal);
      if (attempt === MODEL_CALL_MAX_ATTEMPTS || classifyModelCallError(error) !== "retry") {
        throw error;
      }
      const delayMs =
        MODEL_CALL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      log.warn("model call failed transiently — retrying", {
        attempt,
        delayMs,
        sessionId: diag.sessionId,
        turnId: diag.turnId,
        error,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
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
