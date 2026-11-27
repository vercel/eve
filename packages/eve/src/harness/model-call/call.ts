import { changeHistory } from "#harness/session-machine/history.js";
import type { ApprovalMemory } from "#approval/evaluation.js";
import {
  isStepCount,
  type LanguageModel,
  type LanguageModelCallEndEvent,
  type ModelMessage,
  type TelemetryOptions,
  ToolLoopAgent,
  type ToolSet,
  type TypedToolCall,
} from "ai";

import {
  AuthKey,
  DisabledProviderToolsKey,
  HistoryStateKey,
  ModelMaxOutputTokensKey,
} from "#context/keys.js";
import type { StepCatalog } from "#execution/catalog/step-catalog.js";
import { visibleSkillNotice } from "#execution/skills/instructions.js";
import { workingTaskIds } from "#execution/tasks/model-step.js";
import {
  hydrateSandboxAttachments,
  moveToolResultFilesToUserMessages,
} from "#harness/attachment-staging.js";
import { emitStreamContent } from "#harness/emission.js";
import { historyCallNames, toEntryStep, toEntryStream } from "#harness/execute-call.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import type { GenerationSteering } from "#harness/generation-steering.js";
import { interruptStreamOnFailure } from "#harness/interruptible-stream.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import {
  ContentFilteredModelResponseError,
  EmptyModelResponseError,
  ModelStreamStalledError,
  rejectsCredential,
} from "#harness/model-call/errors.js";
import { type ModelProfile, resolveModelProfile } from "#harness/model-profile.js";
import { awaitsProviderToolResult } from "#harness/provider-tool-history.js";
import { estimateRequestEnvelope } from "#harness/request-envelope.js";
import { summarizeKnownError } from "#harness/semantic-errors/index.js";
import { retryRun } from "#harness/session-machine/runs.js";
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
  runUsageOf,
} from "#harness/step-hooks.js";
import { estimateTokens } from "#harness/token-estimate.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { throwIfSessionStreamDead } from "#harness/session-stream-write-error.js";
import type { StepResult } from "#harness/types.js";
import { stepReference } from "#harness/step/context.js";
import { agentSettings } from "#execution/effective-agent-config.js";
import { createLogger, logError } from "#internal/logging.js";
import { getInputTokenCount } from "#harness/compaction/engine.js";
import { CompactionOverLimitError } from "#harness/compaction/over-limit-error.js";
import { compactedTurnInput, historyBeforeCall } from "#harness/compaction/step.js";
import { reportCompactionFailure, reportModelCallFailure } from "./failure.js";
import { buildGatewayAttributionHeaders, withGatewayTraceContext } from "./model.js";
import {
  isEmptyModelResponse,
  recoverModelCall,
  resolveMaxOutputTokens,
  rethrowNoOutputAsEmptyResponse,
} from "./recovery.js";
import { stepDraft, stepMessages, stepSystem } from "#definitions/step.js";
import { modelInstructions, type RequestMessages, withTrailingUserNote } from "./request.js";
import { answerSkippedToolCalls, extractToolResultCallIds, withCallResults } from "./response.js";
import { ALLOW_RETRY, runModelCallWithRetries, STOP_RETRY } from "./retry.js";
import { withUniqueCallIds } from "./unique-call-ids.js";
import { modelCallErrorInfo } from "./failure.js";
import { prepareModelTools } from "./tools.js";
import {
  executeInlineCalls,
  type InlineCallResults,
  NO_INLINE_CALLS,
} from "#harness/call-executor.js";
import { extractGatewayCostUsd } from "./usage.js";
import type { Usage } from "#protocol/session-events/envelope.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";

const environment = process.env.NODE_ENV ?? "unknown";

const log = createLogger("harness.tool-loop");

const MODEL_OUTPUT_TIMEOUT_MS = 10 * 60_000;
const REASONING_TAIL_CHARS = 1_500;

export interface ModelCallOptions {
  readonly compactedAfterOverflow?: boolean;
  readonly disabledProviderTools?: ReadonlySet<string>;
  readonly emptyResponseAttempts?: number;
  readonly extraSystemNote?: string;
  readonly maxOutputTokensOverride?: number | null;
  readonly reasoningOverride?: AgentReasoningDefinition;
  readonly retryReason?: "empty-response";
  readonly trailingUserNote?: string;
}

interface ModelCallerInput {
  readonly catalog: StepCatalog;
  readonly model: LanguageModel;
  readonly generation: GenerationSteering;
  readonly turnMessages: readonly HarnessModelMessage[];
  readonly approvalMemory: ApprovalMemory;
  readonly projectedMessages: HarnessModelMessage[];
  readonly newRun: () => Promise<void>;
  readonly renewCredential?: (rejection: unknown) => Promise<void>;
  readonly startRun: (attempt: number) => Promise<void>;
}

export class ModelCaller {
  readonly profile: ModelProfile;
  private readonly attributionHeaders: Record<string, string> | undefined;
  private projectedMessages: HarnessModelMessage[];
  private turnMessages: readonly HarnessModelMessage[];
  request: RequestMessages;
  modelMessages: ModelMessage[] = [];
  requestEnvelopeTokens = 0;
  private system: string | readonly string[] = "";
  private unkeptUsage: Usage | undefined;
  private compactionFailure: { readonly error: unknown } | undefined;
  private attemptIndex = 0;
  private started: number | undefined;
  private acceptedOutput = false;
  private lastMaxOutputTokens: number | undefined;

  private readonly step: Step;
  private readonly prompt: Prompt;
  private readonly input: ModelCallerInput;

  constructor(step: Step, prompt: Prompt, input: ModelCallerInput) {
    this.step = step;
    this.prompt = prompt;
    this.input = input;

    this.profile = resolveModelProfile(input.model, stepReference(step).promptCache);
    this.attributionHeaders = buildGatewayAttributionHeaders(
      this.profile,
      step.config.runtimeIdentity,
    );
    this.projectedMessages = input.projectedMessages;
    this.turnMessages = input.turnMessages;
    this.request = {
      history: prompt.messages,
      historyState: step.ctx.get(HistoryStateKey) ?? {},
      nonSystemMessages: input.projectedMessages,
    };
  }

  async call(): Promise<HarnessStepResult> {
    const modelId = stepReference(this.step).id;
    const cachedDisabled = this.step.ctx.get(DisabledProviderToolsKey)?.[modelId];
    const cachedMaxOutput = this.step.ctx.get(ModelMaxOutputTokensKey)?.[modelId];
    let options: ModelCallOptions = {
      ...(cachedDisabled !== undefined &&
        cachedDisabled.length > 0 && { disabledProviderTools: new Set(cachedDisabled) }),
      ...(cachedMaxOutput !== undefined && { maxOutputTokensOverride: cachedMaxOutput }),
    };
    const diagnostics = {
      policies: [() => (this.compactionFailure === undefined ? ALLOW_RETRY : STOP_RETRY)],
      onRetry: (error: unknown) => this.prepareRetry(error),
      sessionId: this.step.session.sessionId,
      turnId: this.step.position().turnId,
    };
    for (;;) {
      try {
        return await runModelCallWithRetries(
          () => this.attempt(options),
          diagnostics,
          this.input.generation.signal,
        );
      } catch (error) {
        throwIfSessionStreamDead(error);
        if (this.compactionFailure !== undefined) throw this.compactionFailure.error;
        throwIfTurnAborted(this.step.config.abortSignal);
        this.input.generation.check();
        const { renewCredential } = this.input;
        if (renewCredential !== undefined && rejectsCredential(error)) {
          await renewCredential(error);
          await this.prepareRetry(error);
          continue;
        }
        if (
          !options.compactedAfterOverflow &&
          summarizeKnownError(error)?.id === "model-context-overflow"
        ) {
          const compacted = await this.compactOnOverflow();
          if (compacted) {
            await this.prepareRetry(error);
            options = { ...options, compactedAfterOverflow: true };
            continue;
          }
        }
        const recovery = recoverModelCall(error, options, {
          ...diagnostics,
          attemptedMaxOutputTokens: this.lastMaxOutputTokens,
        });
        if (recovery === undefined) throw error;
        if (
          recovery.disabledProviderTools !== undefined &&
          recovery.disabledProviderTools.size > 0 &&
          recovery.disabledProviderTools !== options.disabledProviderTools
        ) {
          const previous = this.step.ctx.get(DisabledProviderToolsKey) ?? {};
          const merged = [
            ...new Set([...(previous[modelId] ?? []), ...recovery.disabledProviderTools]),
          ];
          this.step.ctx.set(DisabledProviderToolsKey, { ...previous, [modelId]: merged });
        }
        if (
          recovery.maxOutputTokensOverride !== undefined &&
          recovery.maxOutputTokensOverride !== options.maxOutputTokensOverride
        ) {
          const previous = this.step.ctx.get(ModelMaxOutputTokensKey) ?? {};
          this.step.ctx.set(ModelMaxOutputTokensKey, {
            ...previous,
            [modelId]: recovery.maxOutputTokensOverride,
          });
        }
        await this.prepareRetry(error);
        options = recovery;
      }
    }
  }

  private async prepareRetry(error: unknown): Promise<void> {
    const { step } = this;
    const runId = step.position().runId;
    const attempt = this.started;
    this.started = undefined;
    const usage = this.takeUnkeptUsage();
    if (runId === undefined) return;
    if (this.acceptedOutput) {
      await step.apply(discardAttempt(step.view(), { ending: "retried", runId, usage }));
      this.acceptedOutput = false;
      await this.input.newRun();
      return;
    }
    if (attempt === undefined) return;
    await step.apply(retryRun({ attempt, error: modelCallErrorInfo(error), runId, usage }));
  }

  async failIfCompactionFailed(): Promise<StepResult | undefined> {
    if (this.compactionFailure === undefined) return undefined;
    const { error } = this.compactionFailure;
    if (error instanceof CompactionOverLimitError) {
      return reportCompactionFailure(this.step, error);
    }
    return reportModelCallFailure(this.step, error);
  }

  async abandon(): Promise<void> {
    this.input.generation.end();
    const history = await this.discard("retried");
    this.step.session = changeHistory(this.step.session, { extend: history });
  }

  async steered(): Promise<StepResult> {
    throwIfTurnAborted(this.step.config.abortSignal);
    this.input.generation.end();
    return {
      next: this.step.runStep,
      session: changeHistory(this.step.session, { extend: await this.discard("steered") }),
      steered: true,
    };
  }

  private async discard(ending: "retried" | "steered"): Promise<readonly ModelMessage[]> {
    const { step } = this;
    step.ctx.set(HistoryStateKey, this.request.historyState);
    const runId = step.position().runId;
    if (runId !== undefined) {
      await step.apply(
        discardAttempt(step.view(), { ending, runId, usage: this.takeUnkeptUsage() }),
      );
    }
    return this.request.history;
  }

  takeUnkeptUsage(): Usage | undefined {
    const usage = this.unkeptUsage;
    this.unkeptUsage = undefined;
    return usage;
  }

  private async buildRequest(): Promise<void> {
    const { prompt, step } = this;
    const { catalog } = this.input;
    const call = {
      skillCatalog: catalog.advertised.has(SKILL_TOOL_NAME) ? catalog.skills : undefined,
      currentInput: new Set(this.turnMessages),
      historyState: step.ctx.get(HistoryStateKey) ?? {},
      record: prompt.messages,
    };
    const draft = await stepDraft(step, call);
    this.system = await stepSystem(step, draft);
    const messages = await stepMessages(draft, {
      call,
      project: (record) =>
        projectPrompt({ ...prompt, messages: [...record] }).filter((message) =>
          visibleSkillNotice(message, catalog.skills),
        ),
    });
    this.request = {
      history: messages.record,
      historyState: messages.historyState,
      nonSystemMessages: messages.view,
    };
  }

  private framing(options: ModelCallOptions, messages: readonly ModelMessage[]) {
    const note = options.trailingUserNote;
    const asSystem = note !== undefined && awaitsProviderToolResult(messages);
    const extraSystemNote = asSystem
      ? [options.extraSystemNote, note].filter((part) => part !== undefined).join("\n\n")
      : options.extraSystemNote;
    return {
      instructions: modelInstructions({
        extraSystemNote,
        instructions: this.system,
        profile: this.profile,
      }),
      messages: asSystem ? [...messages] : withTrailingUserNote(messages, note),
    };
  }

  private async prepare(options: ModelCallOptions): Promise<ToolSet> {
    const tools = await prepareModelTools(this.step, {
      catalog: this.input.catalog,
      disabledProviderTools: options.disabledProviderTools,
      profile: this.profile,
    });
    await this.buildRequest();
    this.requestEnvelopeTokens = await estimateRequestEnvelope({
      history: this.projectedMessages,
      ...this.framing(options, this.request.nonSystemMessages),
      tools,
    });
    return tools;
  }

  private async compact(options: ModelCallOptions, tools: ToolSet): Promise<ToolSet> {
    const { step, prompt } = this;
    let compacted: HarnessModelMessage[] | undefined;
    try {
      compacted = await historyBeforeCall(step, {
        messages: prompt.messages,
        model: this.input.model,
        renew: this.input.renewCredential,
        promptMessages: withClientContext(prompt),
        requestEnvelopeTokens: this.requestEnvelopeTokens,
      });
    } catch (error) {
      this.compactionFailure = { error };
      throw error;
    }
    if (compacted === undefined) return tools;
    compactPrompt(step, prompt, compacted);
    const turnInput = compactedTurnInput(prompt.messages);
    this.turnMessages =
      turnInput === undefined ? this.input.turnMessages : [...this.input.turnMessages, turnInput];
    this.projectedMessages = projectPrompt(prompt);
    return await this.prepare(options);
  }

  private async compactOnOverflow(): Promise<boolean> {
    const { step, prompt } = this;
    if (prompt.messages.length <= 1) return false;
    log.warn("model call overflowed context window; running reactive compaction", {
      sessionId: step.session.sessionId,
      turnId: step.position().turnId,
    });
    let compacted: HarnessModelMessage[] | undefined;
    try {
      compacted = await historyBeforeCall(step, {
        force: true,
        messages: prompt.messages,
        model: this.input.model,
        renew: this.input.renewCredential,
        promptMessages: withClientContext(prompt),
        requestEnvelopeTokens: this.requestEnvelopeTokens,
      });
    } catch (error) {
      if (error instanceof CompactionOverLimitError) return false;
      this.compactionFailure = { error };
      throw error;
    }
    if (compacted === undefined) return false;
    compactPrompt(step, prompt, compacted);
    const turnInput = compactedTurnInput(prompt.messages);
    this.turnMessages =
      turnInput === undefined ? this.input.turnMessages : [...this.input.turnMessages, turnInput];
    this.projectedMessages = projectPrompt(prompt);
    return true;
  }

  private async attempt(options: ModelCallOptions): Promise<HarnessStepResult> {
    const { step } = this;
    const { generation, model } = this.input;
    const tools = await this.compact(options, await this.prepare(options));
    const attemptIndex = this.attemptIndex++;
    await this.input.startRun(attemptIndex);
    this.started = attemptIndex;
    this.requestEnvelopeTokens = Math.max(
      0,
      this.requestEnvelopeTokens -
        (estimateTokens(this.request.history) - estimateTokens(this.prompt.messages)),
    );
    generation.begin();
    this.modelMessages = await hydrateSandboxAttachments(this.request.nonSystemMessages);
    if (this.profile.filesOutsideToolResults) {
      this.modelMessages = moveToolResultFilesToUserMessages(this.modelMessages);
    }
    const { instructions, messages: callMessages } = this.framing(options, this.modelMessages);
    const runtimeContext =
      step.instrumentation?.resolveRuntimeContext({
        attempt: attemptIndex,
        emissionState: step.position(),
        environment,
        modelInput: { instructions, messages: this.modelMessages },
        session: step.session,
      }) ?? {};
    if (options.retryReason) runtimeContext["eve.retry.reason"] = options.retryReason;

    const position = step.position();
    const attempt = step.instrumentation?.prepareAttempt({
      isFrameworkTool: (name) => step.frameworkToolNames.has(name),
      runId: position.runId!,
      attempt: attemptIndex,
      runtimeContext,
      stepIndex: position.stepIndex,
      turnId: activeTurnId(position),
    });

    const hooks = buildStepHooks({
      auth: step.ctx.get(AuthKey) ?? null,
      model: stepReference(step),
      profile: this.profile,
      session: step.session,
    });
    const compaction = step.session.compaction;
    const estimatedInputTokens = getInputTokenCount(
      this.request.history,
      compaction,
      this.requestEnvelopeTokens,
      compaction.requestEnvelopeTokens,
    );
    const maxOutputTokens = resolveMaxOutputTokens(
      stepReference(step).contextWindowTokens,
      estimatedInputTokens,
      options.maxOutputTokensOverride,
    );
    this.lastMaxOutputTokens = maxOutputTokens;
    const settings = {
      headers: this.attributionHeaders,
      instructions,
      ...(maxOutputTokens !== undefined && { maxOutputTokens }),
      model: withUniqueCallIds(
        withGatewayTraceContext(
          model,
          this.profile,
          this.step.instrumentation?.gatewayTraceContextHeaders,
        ),
        [
          ...Object.keys(step.view().projection.view.calls),
          ...historyCallNames(callMessages).keys(),
        ],
      ),
      onLanguageModelCallEnd: (event: LanguageModelCallEndEvent) => {
        attempt?.onLanguageModelCallEnd(event);
        if (generation.interrupted) return;
        this.unkeptUsage = runUsageOf({
          costUsd: extractGatewayCostUsd(event.providerMetadata),
          usage: event.usage,
        });
      },
      onError(event: { error: unknown }) {
        if (generation.interrupted) return;
        if (summarizeKnownError(event.error)?.tags.includes("config") === true) return;
        logError(log, "tool-loop stream error", event.error);
      },
      onStepEnd: hooks.onStepEnd,
      onStepStart: hooks.onStepStart,
      prepareStep: hooks.prepareStep,
      reasoning:
        options.reasoningOverride ?? stepReference(step).reasoning ?? agentSettings(step).reasoning,
      runtimeContext,
      stopWhen: isStepCount(1),
      telemetry: attempt?.telemetry,
      timeout: { chunkMs: MODEL_OUTPUT_TIMEOUT_MS, firstChunkMs: MODEL_OUTPUT_TIMEOUT_MS },
      tools,
    };
    const agent = new ToolLoopAgent(settings);

    try {
      return await this.stream(agent, callMessages, hooks.stepResult, attempt?.telemetry);
    } catch (error) {
      throwIfSessionStreamDead(error);
      generation.check();
      if (isAbortError(error) && !generation.signal.aborted) {
        throw new ModelStreamStalledError({ cause: error });
      }
      return rethrowNoOutputAsEmptyResponse(error);
    }
  }

  private async stream(
    agent: ToolLoopAgent,
    messages: ModelMessage[],
    stepResultPromise: Promise<HarnessStepResult>,
    telemetry: TelemetryOptions | undefined,
  ): Promise<HarnessStepResult> {
    const { step } = this;
    const { catalog, generation } = this.input;
    const excludedActionToolNames = new Set([REPLY_TOOL_NAME]);
    const streamResult = await agent.stream({ abortSignal: generation.signal, messages });
    const publish: typeof step.publish = async (publication, published) => {
      this.acceptedOutput = true;
      await step.publish(publication, published);
    };
    const { invalidInputToolCallIds, trailingInlineToolResultParts } = await emitStreamContent(
      publish,
      step.position(),
      toEntryStream(
        interruptStreamOnFailure(streamResult.fullStream, generation.signal),
        catalog.resolve,
      ),
      {
        excludedActionToolNames,
        held: step.finalReplyOnly && workingTaskIds(step.session).length > 0,
        finalReplyOnly: step.finalReplyOnly,
        sessionCall: (callId) => step.view().projection.view.calls[callId],
        tools: catalog,
        interruptSignal: generation.signal,
      },
    );
    throwIfTurnAborted(step.config.abortSignal);
    generation.check();
    const [stepResult, responseMessages] = toEntryStep(
      ...(await Promise.all([stepResultPromise, streamResult.responseMessages])),
      catalog.resolve,
    );
    assertUsableResponse(stepResult, responseMessages, {
      allowEmptyStop: !step.hasDelegatedCaller,
      hasInlineResults: trailingInlineToolResultParts.length > 0,
    });
    const calls = await this.runInlineCalls(stepResult, messages, {
      excludedCallIds: invalidInputToolCallIds,
      telemetry,
    });
    const notRun = answerSkippedToolCalls(stepResult, catalog, invalidInputToolCallIds);
    this.unkeptUsage = undefined;
    await emitStepActions(step.publish, step.position(), stepResult, notRun);
    return withCallResults({
      answers: [...trailingInlineToolResultParts, ...notRun],
      calls,
      invalidInputToolCallIds,
      responseMessages,
      stepResult,
    });
  }

  private async runInlineCalls(
    stepResult: HarnessStepResult,
    messages: readonly ModelMessage[],
    options: {
      readonly excludedCallIds?: ReadonlySet<string>;
      readonly telemetry: TelemetryOptions | undefined;
    },
  ): Promise<InlineCallResults> {
    const { finishReason } = stepResult;
    if (finishReason !== "stop" && finishReason !== "tool-calls") return NO_INLINE_CALLS;
    const { step } = this;
    const results = await executeInlineCalls({
      abortSignal: this.input.generation.signal,
      approvalMemory: this.input.approvalMemory,
      beforeExecute: () => this.input.generation.protectToolExecution(),
      excludedCallIds: options.excludedCallIds ?? new Set(),
      messages,
      modelCallId: stepResult.callId,
      publish: step.publish,
      telemetry: options.telemetry,
      toolCalls: (stepResult.toolCalls ?? []) as TypedToolCall<ToolSet>[],
      tools: this.input.catalog,
    });
    throwIfTurnAborted(step.config.abortSignal);
    return results;
  }
}

function assertUsableResponse(
  stepResult: HarnessStepResult,
  responseMessages: Parameters<typeof extractToolResultCallIds>[0],
  options: { readonly allowEmptyStop: boolean; readonly hasInlineResults: boolean },
): void {
  if (stepResult.finishReason === "content-filter") {
    throw new ContentFilteredModelResponseError(
      readGatewayGenerationId(stepResult.providerMetadata),
    );
  }
  if (options.allowEmptyStop && stepResult.finishReason === "stop") return;
  if (
    isEmptyModelResponse(stepResult) &&
    extractToolResultCallIds(responseMessages).size === 0 &&
    !options.hasInlineResults
  ) {
    throw new EmptyModelResponseError({
      finishReason: stepResult.finishReason,
      reasoningTail: extractReasoningTail(stepResult, responseMessages),
    });
  }
}

function extractReasoningTail(
  stepResult: HarnessStepResult,
  responseMessages: Parameters<typeof extractToolResultCallIds>[0],
): string | undefined {
  const chunks: string[] = [];
  for (const part of stepResult.content ?? []) {
    if (part.type === "reasoning" && typeof part.text === "string" && part.text.length > 0) {
      chunks.push(part.text);
    }
  }
  if (chunks.length === 0) {
    for (const message of responseMessages) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type === "reasoning" && typeof part.text === "string" && part.text.length > 0) {
          chunks.push(part.text);
        }
      }
    }
  }
  const combined = chunks.join("\n").trim();
  if (combined.length === 0) return undefined;
  return combined.length <= REASONING_TAIL_CHARS ? combined : combined.slice(-REASONING_TAIL_CHARS);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
