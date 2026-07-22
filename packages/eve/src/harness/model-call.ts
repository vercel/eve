import {
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  ToolLoopAgent,
  type ToolSet,
  type TypedToolResult,
} from "ai";
import { buildDynamicTools } from "#context/build-dynamic-tools.js";
import { contextStorage } from "#context/container.js";
import { getActiveDynamicModelSelection } from "#context/dynamic-model-lifecycle.js";
import { getAdvertisedTools } from "#harness/advertised-tools.js";
import { emitStreamContent, type HarnessEmissionState } from "#harness/emission.js";
import { buildTelemetryRuntimeContext } from "#harness/instrumentation-runtime-context.js";
import { EmptyModelResponseError } from "#harness/model-call-error.js";
import {
  appendMissingToolResultMessages,
  extractToolResultCallIds,
  isEmptyModelResponse,
  rethrowNoOutputAsEmptyResponse,
  runModelCallWithRetries,
  withAccumulatedResponseMessages,
} from "#harness/model-call-recovery.js";
import { enrichTelemetry } from "#harness/otel-integration.js";
import {
  type AnthropicCacheMarker,
  applyLastToolCacheBreakpoint,
  applySystemCacheBreakpoint,
  type PromptCachePath,
} from "#harness/prompt-cache.js";
import { summarizeKnownError } from "#harness/semantic-errors/index.js";
import { buildStepHooks, emitStepActions, type HarnessStepResult } from "#harness/step-hooks.js";
import {
  buildToolApproval,
  buildToolSetFromDefinitions,
  buildToolSetWithProviderTools,
} from "#harness/tools.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type {
  CompactionConfig,
  HarnessSession,
  HarnessToolMap,
  GenerateConfig,
} from "#harness/types.js";
import { createWorkflowLifecycle } from "#harness/workflow-lifecycle.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { resolveProviderHeaders } from "#internal/gateway.js";
import { createLogger, logError } from "#internal/logging.js";
import type { InstrumentationDefinition } from "#public/instrumentation/index.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { ASK_QUESTION_TOOL_NAME } from "#runtime/framework-tools/ask-question.js";
import {
  buildFinalOutputTool,
  FINAL_OUTPUT_TOOL_NAME,
} from "#runtime/framework-tools/final-output.js";

export const environment = process.env.NODE_ENV ?? "unknown";
export const eveVersion = resolveInstalledPackageInfo().version;

const log = createLogger("harness.generate");

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

function mergeSystemInstructions(
  instructions: readonly SystemModelMessage[],
): SystemModelMessage | undefined {
  if (instructions.length === 0) {
    return undefined;
  }

  if (instructions.length === 1) {
    return { ...instructions[0]! };
  }

  let providerOptions: SystemModelMessage["providerOptions"] | undefined;
  for (const instruction of instructions) {
    if (instruction.providerOptions !== undefined) {
      providerOptions = {
        ...providerOptions,
        ...instruction.providerOptions,
      };
    }
  }

  const merged: SystemModelMessage = {
    role: "system",
    content: instructions.map((instruction) => instruction.content).join("\n\n"),
  };
  if (providerOptions !== undefined) {
    merged.providerOptions = providerOptions;
  }
  return merged;
}

/**
 * Builds AI Gateway app attribution headers when the model is gateway-routed.
 *
 * Bare model ids and `gateway.*` model instances route through AI Gateway.
 * Direct-provider model instances receive no Gateway-specific headers.
 */
export function buildGatewayAttributionHeaders(
  model: LanguageModel,
  runtimeIdentity: GenerateConfig["runtimeIdentity"],
): Record<string, string> | undefined {
  const providerHeaders = resolveProviderHeaders(model);
  if (providerHeaders === undefined) return undefined;

  const title = runtimeIdentity?.agentName ?? runtimeIdentity?.agentId;
  const deploymentHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const referer = deploymentHost ? `https://${deploymentHost}` : undefined;

  const headers: Record<string, string> = { ...providerHeaders };
  if (title) headers["x-title"] = title;
  if (referer) headers["http-referer"] = referer;
  return headers;
}

export async function resolveActiveRuntimeModel(input: {
  readonly config: GenerateConfig;
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

/**
 * What one attempt's `prepareModelCallInput` resolves: the merged system
 * instructions and the sanitized telemetry runtime context for that call.
 */
export type PreparedModelCallInput = {
  readonly instructions: SystemModelMessage | string | undefined;
  readonly telemetryRuntimeContext: Record<string, unknown> | undefined;
};

/**
 * Assembles the effective toolset and ToolLoopAgent for one attempt
 * of this step, then runs the model call.
 *
 * Re-invoked for every transient attempt so an earlier stream cannot
 * resolve the retry's one-shot step hooks with stale partial output.
 * Recovery stages also use it to alter the call shape: unsupported-tool
 * recovery drops the offending tool, while empty-response recovery adds
 * its retry telemetry and follow-up note.
 */
export type ModelCallOptions = {
  disabledProviderTools?: ReadonlySet<string>;
  extraSystemNote?: string;
  preparedInput?: PreparedModelCallInput;
  retryReason?: "empty-response";
  suppressStepStartedEmission?: boolean;
  trailingUserNote?: string;
};

/**
 * Everything `createModelCallRunner` captures for the step's model-call
 * attempts. Values are computed once by the tool loop before the first
 * attempt (mirroring the closures the runner replaced); `session` is the
 * only value the runner updates, via advertised-tool resolution inside an
 * attempt — read it back through {@link ModelCallRunner.currentSession}.
 */
export interface ModelCallRunnerInput {
  readonly agentName: string | undefined;
  readonly approvedTools: ReadonlySet<string>;
  readonly attributionHeaders: Record<string, string> | undefined;
  readonly cachePath: PromptCachePath;
  readonly config: GenerateConfig;
  readonly ctx: ReturnType<typeof contextStorage.getStore>;
  readonly emissionState: HarnessEmissionState;
  readonly emit: GenerateConfig["handleEvent"];
  readonly marker: AnthropicCacheMarker | undefined;
  readonly model: LanguageModel;
  readonly modelMessages: ModelMessage[];
  readonly session: HarnessSession;
  readonly systemMessages: SystemModelMessage[];
  readonly telemetryConfig: InstrumentationDefinition | undefined;
}

/** The model-call surface one harness step drives. */
export interface ModelCallRunner {
  /**
   * Latest session snapshot, including advertised-tool updates made by
   * attempts. The tool loop re-reads this after the call (and after the
   * recovery pipeline) exactly where its own `session` local used to be
   * rebound from inside the call closure.
   */
  currentSession(): HarnessSession;
  prepareModelCallInput(extraSystemNote?: string): PreparedModelCallInput;
  runOneModelCall(opts: ModelCallOptions): Promise<HarnessStepResult>;
}

export function createModelCallRunner(input: ModelCallRunnerInput): ModelCallRunner {
  const {
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
    systemMessages,
    telemetryConfig,
  } = input;
  let session = input.session;

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
    const markedInstructions =
      rawInstructions !== undefined && marker
        ? applySystemCacheBreakpoint(rawInstructions, marker)
        : rawInstructions;
    const instructions =
      markedInstructions !== undefined
        ? mergeSystemInstructions(markedInstructions)
        : (session.agent.system ?? undefined);

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

  const runSingleModelCall = async (opts: ModelCallOptions): Promise<HarnessStepResult> => {
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
        if (summarizeKnownError(event.error)?.tags.includes("config") === true) return;
        logError(log, "generate stream error", event.error);
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
          trailingInlineToolResultParts,
        } = await emitStreamContent(emit, emissionState, streamResult.fullStream, {
          excludedActionToolNames,
          tools: config.tools,
        });
        throwIfTurnAborted(config.abortSignal);
        const [stepResult, accumulatedResponseMessages] = await Promise.all([
          hooks.stepResult,
          streamResult.responseMessages,
        ]);
        if (
          isEmptyModelResponse(stepResult) &&
          extractToolResultCallIds(accumulatedResponseMessages).size === 0 &&
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
        const existingToolResults = stepResult.toolResults as TypedToolResult<ToolSet>[];
        const toolResultsByCallId = new Map(
          existingToolResults.map((toolResult) => [toolResult.toolCallId, toolResult]),
        );
        for (const toolResult of inlineAuthorizationResults) {
          toolResultsByCallId.set(toolResult.toolCallId, toolResult);
        }
        return withAccumulatedResponseMessages({
          invalidInputToolCallIds,
          responseMessages: appendMissingToolResultMessages({
            append: trailingInlineToolResultParts,
            responseMessages: accumulatedResponseMessages,
          }),
          stepResult,
          toolResults: [...toolResultsByCallId.values()],
        });
      }
      const generateResult = await agent.generate({
        abortSignal: config.abortSignal,
        messages: callMessages,
      });
      throwIfTurnAborted(config.abortSignal);
      const stepResult = await hooks.stepResult;
      if (
        isEmptyModelResponse(stepResult) &&
        extractToolResultCallIds(generateResult.responseMessages).size === 0
      ) {
        throw new EmptyModelResponseError();
      }
      return withAccumulatedResponseMessages({
        responseMessages: generateResult.responseMessages,
        stepResult,
      });
    };

    return executeModelCall().catch(rethrowNoOutputAsEmptyResponse);
  };

  const runOneModelCall = async (opts: ModelCallOptions): Promise<HarnessStepResult> =>
    runModelCallWithRetries(
      (attempt) =>
        runSingleModelCall({
          ...opts,
          preparedInput: attempt === 1 ? opts.preparedInput : undefined,
          suppressStepStartedEmission: attempt === 1 ? opts.suppressStepStartedEmission : true,
        }),
      {
        sessionId: session.sessionId,
        turnId: emissionState.turnId,
      },
      config.abortSignal,
    );

  return {
    currentSession: () => session,
    prepareModelCallInput,
    runOneModelCall,
  };
}
