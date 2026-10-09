import { createStepCompletedEvent } from "#protocol/message.js";
import {
  isStepCount,
  type LanguageModel,
  type LanguageModelCallEndEvent,
  type ModelMessage,
  ToolLoopAgent,
  type ToolSet,
  type TypedToolResult,
} from "ai";

import { AuthKey, HistoryStateKey } from "#context/keys.js";
import type { StepCatalog } from "#execution/catalog/step-catalog.js";
import { workingTaskIds } from "#execution/tasks/model-step.js";
import {
  hydrateSandboxAttachments,
  moveToolResultFilesToUserMessages,
} from "#harness/attachment-staging.js";
import { emitStreamContent } from "#harness/emission.js";
import { toEntryStep, toEntryStream, toEntryTelemetry } from "#harness/execute-call.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import type { GenerationSteering } from "#harness/generation-steering.js";
import { interruptStreamOnFailure } from "#harness/interruptible-stream.js";
import type { HarnessModelMessage, UserModelMessage } from "#harness/messages.js";
import {
  ContentFilteredModelResponseError,
  EmptyModelResponseError,
} from "#harness/model-call/errors.js";
import { type ModelProfile, resolveModelProfile } from "#harness/model-profile.js";
import { estimateRequestEnvelope } from "#harness/request-envelope.js";
import { summarizeKnownError } from "#harness/semantic-errors/index.js";
import { discardAttempt } from "#harness/session-machine/transitions.js";
import { activeTurnId } from "#harness/session-machine/view.js";
import type { Step } from "#harness/step/context.js";
import {
  compactPrompt,
  projectPrompt,
  type Prompt,
  withClientContext,
} from "#harness/step/prompt.js";
import {
  buildStepHooks,
  emitStepActions,
  type HarnessStepResult,
  readGatewayGenerationId,
} from "#harness/step-hooks.js";
import { estimateTokens } from "#harness/token-estimate.js";
import { buildToolApproval } from "#harness/tools.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { addTurnUsage, type TokenUsageDelta } from "#harness/turn-tag-state.js";
import type { StepResult } from "#harness/types.js";
import type { InstrumentationAttempt } from "#instrumentation/runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import { maybeCompact } from "#harness/compaction/step.js";
import { buildGatewayAttributionHeaders } from "./model.js";
import { isEmptyModelResponse, rethrowNoOutputAsEmptyResponse } from "./recovery.js";
import {
  modelInstructions,
  requestMessages,
  type RequestMessages,
  withTrailingUserNote,
} from "./request.js";
import {
  appendMissingToolResultMessages,
  answerSkippedToolCalls,
  extractToolResultCallIds,
  withAccumulatedResponseMessages,
} from "./response.js";
import { withRejectedProviderTools } from "./recovery.js";
import { runModelCallWithRetries } from "./retry.js";
import { logToolExecutionError, prepareModelTools } from "./tools.js";
import { extractGatewayCostUsd, extractTokenUsageDelta } from "./usage.js";

const environment = process.env.NODE_ENV ?? "unknown";

const log = createLogger("harness.tool-loop");

/** How one attempt differs from the step's first: what recovery and retries change. */
export interface ModelCallOptions {
  readonly disabledProviderTools?: ReadonlySet<string>;
  readonly extraSystemNote?: string;
  readonly retryReason?: "empty-response";
  readonly suppressStepStartedEmission?: boolean;
  readonly trailingUserNote?: string;
}

/** What a model step's caller needs from the step. */
interface ModelCallerInput {
  /** The step's catalog: what the model can call, and what each call runs. */
  readonly catalog: StepCatalog;
  readonly model: LanguageModel;
  readonly generation: GenerationSteering;
  readonly hidesHeldText: boolean;
  readonly turnMessages: readonly UserModelMessage[];
  readonly approvedTools: ReadonlySet<string>;
  readonly pendingApprovalsNote: string | undefined;
  /** The prompt as the step started it, projected for the model. */
  readonly projectedMessages: HarnessModelMessage[];
  readonly startStep: (messages: readonly ModelMessage[]) => Promise<void>;
  readonly setAttemptScope: (scope: InstrumentationAttempt | undefined) => void;
}

/**
 * Calls the model for one step. Each attempt rebuilds the tools, the request, and the agent, so an
 * earlier stream can't resolve a retry's one-shot step hooks with stale partial output. An attempt
 * may first compact the prompt, which rewrites the durable messages the step later commits.
 */
export class ModelCaller {
  readonly profile: ModelProfile;
  private readonly attributionHeaders: Record<string, string> | undefined;
  /** The prompt as the model reads it, projected for its history view. */
  private projectedMessages: HarnessModelMessage[];
  /** The latest attempt's request; its history is what the step commits. */
  request: RequestMessages;
  /** The messages the latest attempt sent, after attachments were hydrated. */
  modelMessages: ModelMessage[] = [];
  requestEnvelopeTokens = 0;
  /** Usage of a call steering interrupted, which the steered step still counts. */
  private interruptedUsage: TokenUsageDelta | undefined;
  private compactionFailure: { readonly error: unknown } | undefined;
  private attemptIndex = 0;

  private readonly step: Step;
  private readonly prompt: Prompt;
  private readonly input: ModelCallerInput;

  constructor(step: Step, prompt: Prompt, input: ModelCallerInput) {
    this.step = step;
    this.prompt = prompt;
    this.input = input;

    this.profile = resolveModelProfile(input.model);
    this.attributionHeaders = buildGatewayAttributionHeaders(
      this.profile,
      step.config.runtimeIdentity,
    );
    this.projectedMessages = input.projectedMessages;
    this.request = this.buildRequest();
  }

  /** Calls the model, retrying transient failures. */
  async call(options: ModelCallOptions): Promise<HarnessStepResult> {
    // Calls the current attempt announced that haven't received a result yet, by tool name.
    let unsettledActionToolNames = new Map<string, string>();
    return await runModelCallWithRetries(
      async (attempt) => {
        if (attempt > 1) {
          await this.settleRetriedActions(unsettledActionToolNames);
          unsettledActionToolNames = new Map<string, string>();
        }
        return await this.attempt(
          {
            ...options,
            suppressStepStartedEmission: attempt === 1 ? options.suppressStepStartedEmission : true,
          },
          unsettledActionToolNames,
        );
      },
      {
        canRetry: () => this.compactionFailure === undefined,
        sessionId: this.step.session.sessionId,
        turnId: this.step.position().turnId,
      },
      this.input.generation.signal,
    );
  }

  /**
   * Answers the calls a discarded attempt announced, so none stays open once the replacement
   * attempt starts. The replacement re-requests whatever the model still wants to run.
   */
  private async settleRetriedActions(unsettled: Map<string, string>): Promise<void> {
    // One call per transition: publishing isn't atomic, so a publish that fails partway leaves
    // only the calls it didn't reach for the next attempt to settle.
    for (const [callId, toolName] of unsettled) {
      await this.step.apply(discardAttempt(this.step.view(), { calls: [{ callId, toolName }] }));
      unsettled.delete(callId);
    }
  }

  /** A failed compaction fails the step, whatever recovery the call attempted. */
  throwIfCompactionFailed(): void {
    if (this.compactionFailure !== undefined) throw this.compactionFailure.error;
  }

  /** Steering interrupted the call: the step ends with what it committed, and runs again. */
  async steered(): Promise<StepResult> {
    const { step } = this;
    throwIfTurnAborted(step.config.abortSignal);
    step.ctx?.set(HistoryStateKey, this.request.historyState);
    if (this.interruptedUsage !== undefined) {
      step.session = addTurnUsage(step.session, step.position().turnId, this.interruptedUsage);
    }
    await step.emit?.(
      createStepCompletedEvent({
        ...step.position(),
        finishReason: "other",
        usage: this.interruptedUsage,
      }),
    );
    return {
      next: step.runStep,
      session: { ...step.session, history: [...this.request.history] },
      steered: true,
    };
  }

  /** The step's result counted its usage, so an interrupted call's usage no longer applies. */
  clearInterruptedUsage(): void {
    this.interruptedUsage = undefined;
  }

  private buildRequest(): RequestMessages {
    return requestMessages(this.step, {
      catalog: this.input.catalog,
      hidesHeldText: this.input.hidesHeldText,
      messages: this.prompt.messages,
      pendingApprovalsNote: this.input.pendingApprovalsNote,
      projectedMessages: this.projectedMessages,
      turnMessages: this.input.turnMessages,
    });
  }

  private instructions(extraSystemNote: string | undefined) {
    return modelInstructions({
      anthropicCache: this.profile.anthropicCache,
      extraSystemNote,
      session: this.step.session,
      systemMessages: this.request.systemMessages,
    });
  }

  private async prepare(options: ModelCallOptions): Promise<ToolSet> {
    const tools = await prepareModelTools(this.step, {
      catalog: this.input.catalog,
      disabledProviderTools: withRejectedProviderTools(
        this.input.model,
        options.disabledProviderTools,
      ),
      generation: this.input.generation,
      profile: this.profile,
    });
    this.request = this.buildRequest();
    this.requestEnvelopeTokens = await estimateRequestEnvelope({
      history: this.projectedMessages,
      instructions: this.instructions(options.extraSystemNote),
      messages: withTrailingUserNote(this.request.nonSystemMessages, options.trailingUserNote),
      tools,
    });
    return tools;
  }

  /** Compacts the prompt when it's over the threshold, then rebuilds what depends on it. */
  private async compact(options: ModelCallOptions, tools: ToolSet): Promise<ToolSet> {
    const { step, prompt } = this;
    const { config } = step;
    let compaction: Awaited<ReturnType<typeof maybeCompact>>;
    try {
      compaction = await maybeCompact({
        abortSignal: config.abortSignal,
        auth: step.ctx?.get(AuthKey) ?? null,
        emissionState: step.position(),
        historyProjector: config.historyProjector,
        messages: [...prompt.messages],
        model: this.input.model,
        promptMessages: withClientContext(prompt),
        publish: step.publish,
        requestEnvelopeTokens: this.requestEnvelopeTokens,
        resolveModel: config.resolveModel,
        runtimeIdentity: config.runtimeIdentity,
        session: step.session,
        telemetry: step.instrumentation?.telemetry(),
      });
      if (compaction.failure !== undefined) throw compaction.failure.error;
    } catch (error) {
      this.compactionFailure = { error };
      throw error;
    }
    step.session = compaction.session;
    if (!compaction.compacted) return tools;
    compactPrompt(step, prompt, compaction.messages);
    const { compaction: settings } = step.session;
    step.session = {
      ...step.session,
      compaction: {
        recentWindowSize: settings.recentWindowSize,
        threshold: settings.threshold,
        thresholdPercent: settings.thresholdPercent,
      },
    };
    this.projectedMessages = projectPrompt(step, prompt);
    return await this.prepare(options);
  }

  private async attempt(
    options: ModelCallOptions,
    unsettledActionToolNames: Map<string, string>,
  ): Promise<HarnessStepResult> {
    const { step } = this;
    const { catalog, generation, model } = this.input;
    const tools = await this.compact(options, await this.prepare(options));
    // New announcements join durable history, so they must not inflate the
    // envelope baseline and hide instruction growth on the next step.
    this.requestEnvelopeTokens = Math.max(
      0,
      this.requestEnvelopeTokens -
        (estimateTokens(this.request.history) - estimateTokens(this.prompt.messages)),
    );
    generation.begin();
    // Hydrate `eve-sandbox:` file refs for this call only; history keeps the refs.
    this.modelMessages = await hydrateSandboxAttachments(this.request.nonSystemMessages);
    if (this.profile.filesOutsideToolResults) {
      this.modelMessages = moveToolResultFilesToUserMessages(this.modelMessages);
    }
    const instructions = this.instructions(options.extraSystemNote);
    const runtimeContext =
      step.instrumentation?.resolveRuntimeContext({
        emissionState: step.position(),
        environment,
        modelInput: { instructions, messages: this.modelMessages },
        session: step.session,
      }) ?? {};
    // Label a reissued call's telemetry; otherwise a retry shows only as a second span.
    if (options.retryReason) runtimeContext["eve.retry.reason"] = options.retryReason;
    // A trailing note rather than a system one keeps the provider's cached prefix valid; the
    // step commits its prompt messages, so the note exists only on this call's request.
    const callMessages = withTrailingUserNote(this.modelMessages, options.trailingUserNote);

    const position = step.position();
    const attempt = step.instrumentation?.prepareAttempt({
      isFrameworkTool: (name) => step.frameworkToolNames.has(name),
      attemptIndex: this.attemptIndex++,
      runtimeContext,
      stepIndex: position.stepIndex,
      turnId: activeTurnId(position),
    });
    this.input.setAttemptScope(attempt?.scope);

    const hooks = buildStepHooks({
      auth: step.ctx?.get(AuthKey) ?? null,
      profile: this.profile,
      session: step.session,
      startStep: options.suppressStepStartedEmission === true ? undefined : this.input.startStep,
    });
    const settings = {
      headers: this.attributionHeaders,
      instructions,
      model,
      onLanguageModelCallEnd: (event: LanguageModelCallEndEvent) => {
        if (generation.interrupted) return;
        this.interruptedUsage = extractTokenUsageDelta({
          costUsd: extractGatewayCostUsd(event.providerMetadata),
          usage: event.usage,
        });
      },
      onToolExecutionEnd: (event: Parameters<typeof logToolExecutionError>[0]) =>
        logToolExecutionError(event, catalog.resolve),
      // Replaces the AI SDK's default `console.error`; the harness reports failures as events.
      onError(event: { error: unknown }) {
        if (generation.interrupted) return;
        // A recognized configuration failure skips the raw dump: its stack points at the
        // harness, not the fix, and the failure path logs a one-line summary.
        if (summarizeKnownError(event.error)?.tags.includes("config") === true) return;
        logError(log, "tool-loop stream error", event.error);
      },
      onStepEnd: hooks.onStepEnd,
      onStepStart: hooks.onStepStart,
      prepareStep: hooks.prepareStep,
      reasoning: step.session.agent.modelReference?.reasoning ?? step.session.agent.reasoning,
      runtimeContext,
      stopWhen: isStepCount(1),
      telemetry: toEntryTelemetry(attempt?.telemetry, catalog.resolve),
      toolApproval: buildToolApproval({
        abortSignal: generation.signal,
        approvedTools: this.input.approvedTools,
        resolve: catalog.resolve,
      }),
      tools,
    };
    const agent = new ToolLoopAgent(settings);

    try {
      const result = await this.stream(
        agent,
        callMessages,
        hooks.stepResult,
        unsettledActionToolNames,
      );
      await attempt?.complete();
      return result;
    } catch (error) {
      if (generation.interrupted) await attempt?.complete();
      else await attempt?.fail(error);
      generation.check();
      return rethrowNoOutputAsEmptyResponse(error);
    }
  }

  /** Streams the call, publishing its content as it arrives. */
  private async stream(
    agent: ToolLoopAgent,
    messages: ModelMessage[],
    stepResultPromise: Promise<HarnessStepResult>,
    unsettledActionToolNames: Map<string, string>,
  ): Promise<HarnessStepResult> {
    const { step } = this;
    const { catalog, generation } = this.input;
    const excludedActionToolNames = new Set([REPLY_TOOL_NAME]);
    const streamResult = await agent.stream({ abortSignal: generation.signal, messages });
    const {
      emittedActionCallIds,
      handledInlineToolResultCallIds,
      invalidInputToolCallIds,
      inlineAuthorizationResults,
      trailingInlineToolResultParts,
    } = await emitStreamContent(
      step.publish,
      step.position(),
      toEntryStream(
        interruptStreamOnFailure(streamResult.fullStream, generation.signal),
        catalog.resolve,
      ),
      {
        excludedActionToolNames,
        hidesHeldText: this.input.hidesHeldText && workingTaskIds(step.session).length > 0,
        tools: catalog,
        unsettledActionToolNames,
      },
    );
    throwIfTurnAborted(step.config.abortSignal);
    generation.check();
    const [stepResult, accumulatedResponseMessages] = toEntryStep(
      ...(await Promise.all([stepResultPromise, streamResult.responseMessages])),
      catalog.resolve,
    );
    assertUsableResponse(
      stepResult,
      accumulatedResponseMessages,
      inlineAuthorizationResults.length > 0 || trailingInlineToolResultParts.length > 0,
    );
    const skipped = answerSkippedToolCalls(stepResult, catalog);
    await emitStepActions(
      step.publish,
      step.position(),
      skipped.length === 0
        ? stepResult
        : withAccumulatedResponseMessages({
            stepResult,
            responseMessages: appendMissingToolResultMessages({
              append: skipped,
              responseMessages: stepResult.response.messages,
            }),
          }),
      {
        emittedActionCallIds,
        excludedActionCallIds: invalidInputToolCallIds,
        excludedActionToolNames,
        handledInlineToolResultCallIds,
        tools: catalog,
      },
    );
    const toolResultsByCallId = new Map(
      (stepResult.toolResults as TypedToolResult<ToolSet>[]).map((toolResult) => [
        toolResult.toolCallId,
        toolResult,
      ]),
    );
    for (const toolResult of inlineAuthorizationResults) {
      toolResultsByCallId.set(toolResult.toolCallId, toolResult);
    }
    return withAccumulatedResponseMessages({
      invalidInputToolCallIds,
      responseMessages: appendMissingToolResultMessages({
        append: [...trailingInlineToolResultParts, ...answerSkippedToolCalls(stepResult, catalog)],
        responseMessages: accumulatedResponseMessages,
      }),
      stepResult,
      toolResults: [...toolResultsByCallId.values()],
    });
  }
}

/**
 * A filtered response fails the step, and an empty one, without output or any tool result, is
 * retried by the empty-response recovery.
 */
function assertUsableResponse(
  stepResult: HarnessStepResult,
  responseMessages: Parameters<typeof extractToolResultCallIds>[0],
  hasInlineResults: boolean,
): void {
  if (stepResult.finishReason === "content-filter") {
    throw new ContentFilteredModelResponseError(
      readGatewayGenerationId(stepResult.providerMetadata),
    );
  }
  if (
    isEmptyModelResponse(stepResult) &&
    extractToolResultCallIds(responseMessages).size === 0 &&
    !hasInlineResults
  ) {
    throw new EmptyModelResponseError();
  }
}
