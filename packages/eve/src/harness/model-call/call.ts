import { withoutPromptMeasurement } from "#harness/compaction/engine.js";
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

import { AuthKey, HistoryStateKey } from "#context/keys.js";
import type { StepCatalog } from "#execution/catalog/step-catalog.js";
import { workingTaskIds } from "#execution/tasks/model-step.js";
import {
  hydrateSandboxAttachments,
  moveToolResultFilesToUserMessages,
} from "#harness/attachment-staging.js";
import { emitStreamContent } from "#harness/emission.js";
import { historyCallNames, toEntryStep, toEntryStream } from "#harness/execute-call.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import type { GenerationSteering } from "#harness/generation-steering.js";
import { interruptStreamOnFailure } from "#harness/interruptible-stream.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import {
  ContentFilteredModelResponseError,
  EmptyModelResponseError,
  ModelStreamStalledError,
} from "#harness/model-call/errors.js";
import { type ModelProfile, resolveModelProfile } from "#harness/model-profile.js";
import { estimateRequestEnvelope } from "#harness/request-envelope.js";
import { summarizeKnownError } from "#harness/semantic-errors/index.js";
import { fact, usageOf } from "#harness/facts.js";
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
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { requireSessionModelReference, type StepResult } from "#harness/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { CompactionOverLimitError } from "#harness/compaction/over-limit-error.js";
import { compactedTurnInput, maybeCompact } from "#harness/compaction/step.js";
import { nextChangeId, nextRunId } from "#protocol/session-projection.js";
import { reportCompactionFailure, reportModelCallFailure } from "./failure.js";
import { buildGatewayAttributionHeaders, withGatewayTraceContext } from "./model.js";
import {
  isEmptyModelResponse,
  recoverModelCall,
  rethrowNoOutputAsEmptyResponse,
} from "./recovery.js";
import {
  modelInstructions,
  requestMessages,
  type RequestMessages,
  withTrailingUserNote,
} from "./request.js";
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
import { extractGatewayCostUsd, extractTokenUsageDelta, type TokenUsageDelta } from "./usage.js";

const environment = process.env.NODE_ENV ?? "unknown";

const log = createLogger("harness.tool-loop");

/**
 * How long a model stream may go without output before the AI SDK abandons it and the
 * call retries. Generous because reasoning can stay silent for minutes; tool execution
 * does not count. Without it, a stream that stalls without closing holds the turn forever.
 */
const MODEL_OUTPUT_TIMEOUT_MS = 10 * 60_000;

/** How one attempt differs from the step's first: what recovery and retries change. */
export interface ModelCallOptions {
  readonly disabledProviderTools?: ReadonlySet<string>;
  readonly extraSystemNote?: string;
  readonly retryReason?: "empty-response";
  readonly trailingUserNote?: string;
}

/** What a model step's caller needs from the step. */
interface ModelCallerInput {
  /** The step's catalog: what the model can call, and what each call runs. */
  readonly catalog: StepCatalog;
  readonly model: LanguageModel;
  readonly generation: GenerationSteering;
  readonly turnMessages: readonly HarnessModelMessage[];
  readonly approvalMemory: ApprovalMemory;
  readonly pendingApprovalsNote: string | undefined;
  /** The prompt as the step started it, projected for the model. */
  readonly projectedMessages: HarnessModelMessage[];
  /** Requests a run to replace one an attempt gave up. */
  readonly newRun: () => Promise<void>;
  /** Starts an attempt at the run as its provider call begins, once any compaction settled. */
  readonly startRun: (attempt: number) => Promise<void>;
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
  /** The step's announcements go before the first of these the prompt has. */
  private turnMessages: readonly HarnessModelMessage[];
  /** The latest attempt's request; its history is what the step commits. */
  request: RequestMessages;
  /** The messages the latest attempt sent, after attachments were hydrated. */
  modelMessages: ModelMessage[] = [];
  requestEnvelopeTokens = 0;
  /** Usage of a call steering interrupted, which the steered step still counts. */
  private interruptedUsage: TokenUsageDelta | undefined;
  private compactionFailure: { readonly error: unknown } | undefined;
  /** Tries at this model step, across the runs a retry after output replaced. */
  private attemptIndex = 0;
  /** The attempt the stream last heard start, until it hears how it ended. */
  private started: number | undefined;
  /** The latest attempt published output, so retrying it gives its run up. */
  private acceptedOutput = false;

  private readonly step: Step;
  private readonly prompt: Prompt;
  private readonly input: ModelCallerInput;

  constructor(step: Step, prompt: Prompt, input: ModelCallerInput) {
    this.step = step;
    this.prompt = prompt;
    this.input = input;

    this.profile = resolveModelProfile(
      input.model,
      requireSessionModelReference(step.session).promptCache,
    );
    this.attributionHeaders = buildGatewayAttributionHeaders(
      this.profile,
      step.config.runtimeIdentity,
    );
    this.projectedMessages = input.projectedMessages;
    this.turnMessages = input.turnMessages;
    this.request = this.buildRequest();
  }

  /** Calls the model, retrying transient failures. */
  async call(): Promise<HarnessStepResult> {
    let options: ModelCallOptions = {};
    const diagnostics = {
      // A summary that failed already settled the compaction; another attempt can't redo it.
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
        if (this.compactionFailure !== undefined) throw this.compactionFailure.error;
        throwIfTurnAborted(this.step.config.abortSignal);
        this.input.generation.check();
        const recovery = recoverModelCall(error, options, diagnostics);
        if (recovery === undefined) throw error;
        await this.prepareRetry(error);
        options = recovery;
      }
    }
  }

  /**
   * Once a failed attempt will be tried again. One that published output gives its run up for a
   * new one: the calls it announced settle `abandoned`, since eve can't tell whether they ran. One
   * that published nothing retries in the same run, and the stream hears why.
   */
  private async prepareRetry(error: unknown): Promise<void> {
    const { step } = this;
    const runId = step.position().runId;
    const attempt = this.started;
    this.started = undefined;
    if (runId === undefined) return;
    if (this.acceptedOutput) {
      await step.apply(discardAttempt(step.view(), { ending: "retried", runId }));
      this.acceptedOutput = false;
      await this.input.newRun();
      return;
    }
    if (attempt === undefined) return;
    await step.apply([fact("model.retried", { attempt, error: modelCallErrorInfo(error), runId })]);
  }

  /**
   * A failed compaction fails the step, whatever recovery the call attempted.
   * One that left the history over the limit ends the session with its message;
   * any other failure is reported like a failed model call, since its summary
   * call already retried. Rethrowing would make the workflow replay the step and
   * then end the session.
   */
  async failIfCompactionFailed(): Promise<StepResult | undefined> {
    if (this.compactionFailure === undefined) return undefined;
    const { error } = this.compactionFailure;
    if (error instanceof CompactionOverLimitError) {
      return reportCompactionFailure(this.step, error);
    }
    return reportModelCallFailure(this.step, error);
  }

  /** Steering interrupted the call: the step ends with what it committed, and runs again. */
  async steered(): Promise<StepResult> {
    const { step } = this;
    throwIfTurnAborted(step.config.abortSignal);
    this.input.generation.end();
    // The cut response never reaches history, so the calls it announced never run, even once its
    // response ended and only their approvals were being decided.
    step.ctx?.set(HistoryStateKey, this.request.historyState);
    const runId = step.position().runId;
    if (runId !== undefined) {
      await step.apply(
        discardAttempt(step.view(), {
          ending: "steered",
          runId,
          usage: this.interruptedUsage === undefined ? undefined : usageOf(this.interruptedUsage),
        }),
      );
    }
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
      messages: this.prompt.messages,
      pendingApprovalsNote: this.input.pendingApprovalsNote,
      projectedMessages: this.projectedMessages,
      turnMessages: this.turnMessages,
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
      disabledProviderTools: options.disabledProviderTools,
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
      const { projection } = step.view();
      compaction = await maybeCompact({
        abortSignal: config.abortSignal,
        auth: step.ctx?.get(AuthKey) ?? null,
        change: {
          changeId: nextChangeId(projection),
          summaryRunId: nextRunId(projection),
          turnId: step.position().turnId,
        },
        ctx: step.ctx,
        emissionState: step.position(),
        // A hook's compact intent compacts before this call, once.
        messages: [...prompt.messages],
        model: this.input.model,
        promptMessages: withClientContext(prompt),
        publish: step.publish,
        view: () => step.view().projection.view,
        requestEnvelopeTokens: this.requestEnvelopeTokens,
        resolveModel: config.resolveModel,
        runtimeIdentity: config.runtimeIdentity,
        session: step.session,
        prepareTelemetry: (runId) =>
          step.instrumentation?.prepareAttempt({
            runId,
            attempt: 0,
            turnId: activeTurnId(step.position()),
          }).telemetry,
        traceContextHeaders: step.instrumentation?.gatewayTraceContextHeaders,
      });
      step.session = compaction.session;
      if (compaction.failure !== undefined) throw compaction.failure.error;
    } catch (error) {
      this.compactionFailure = { error };
      throw error;
    }
    if (!compaction.compacted) return tools;
    compactPrompt(step, prompt, compaction.messages);
    // Compaction cleared what earlier requests announced, so this request announces it again. A
    // step that continues from tool results has no input of its own, so the announcement goes
    // before the turn's input, not after those results where the model reads it as the newest
    // message.
    const turnInput = compactedTurnInput(prompt.messages);
    this.turnMessages =
      turnInput === undefined ? this.input.turnMessages : [...this.input.turnMessages, turnInput];
    step.session = {
      ...step.session,
      compaction: withoutPromptMeasurement(step.session.compaction),
    };
    this.projectedMessages = projectPrompt(prompt);
    return await this.prepare(options);
  }

  private async attempt(options: ModelCallOptions): Promise<HarnessStepResult> {
    const { step } = this;
    const { generation, model } = this.input;
    const tools = await this.compact(options, await this.prepare(options));
    const attemptIndex = this.attemptIndex++;
    await this.input.startRun(attemptIndex);
    this.started = attemptIndex;
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
        attempt: attemptIndex,
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
      runId: position.runId!,
      attempt: attemptIndex,
      runtimeContext,
      stepIndex: position.stepIndex,
      turnId: activeTurnId(position),
    });

    const hooks = buildStepHooks({
      auth: step.ctx?.get(AuthKey) ?? null,
      profile: this.profile,
      session: step.session,
    });
    const settings = {
      headers: this.attributionHeaders,
      instructions,
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
        if (generation.interrupted) return;
        this.interruptedUsage = extractTokenUsageDelta({
          costUsd: extractGatewayCostUsd(event.providerMetadata),
          usage: event.usage,
        });
      },
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
      telemetry: attempt?.telemetry,
      timeout: { chunkMs: MODEL_OUTPUT_TIMEOUT_MS, firstChunkMs: MODEL_OUTPUT_TIMEOUT_MS },
      tools,
    };
    const agent = new ToolLoopAgent(settings);

    try {
      return await this.stream(agent, callMessages, hooks.stepResult, attempt?.telemetry);
    } catch (error) {
      generation.check();
      // Only the output timeout above aborts the stream without aborting our signal.
      if (isAbortError(error) && !generation.signal.aborted) {
        throw new ModelStreamStalledError({ cause: error });
      }
      return rethrowNoOutputAsEmptyResponse(error);
    }
  }

  /**
   * Streams the call, publishing its content as it arrives. `telemetry` is the attempt's, so the
   * calls it runs are traced inside it, as the AI SDK traced the calls it ran.
   */
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
    // Anything the attempt publishes ties a retry to a new run.
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
    await emitStepActions(step.publish, step.position(), stepResult, notRun);
    return withCallResults({
      answers: [...trailingInlineToolResultParts, ...notRun],
      calls,
      invalidInputToolCallIds,
      responseMessages,
      stepResult,
    });
  }

  /**
   * Runs the response's local calls, unless it ended early: then they don't run, and
   * `answerSkippedToolCalls` tells the model so.
   */
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
    // A cancelled turn settles its calls itself, so whatever a cut call returned is dropped.
    throwIfTurnAborted(step.config.abortSignal);
    return results;
  }
}

/**
 * A filtered response fails the step. A successful empty `stop` is usable only
 * when no delegated caller needs a reply.
 */

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
    throw new EmptyModelResponseError();
  }
}

/** An aborted stream surfaces as `AbortError`; an aborted provider fetch rejects with the reason. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
