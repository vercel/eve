import {
  exceedsLimit,
  getInputTokenCount,
  withoutPromptMeasurement,
} from "#harness/compaction/measure.js";
import type { CompactionContext, CompactionStrategy } from "#harness/compaction/strategy.js";
import { resolveMockAuthoredRuntimeModel } from "#runtime/agent/mock-model-adapter.js";
import { cloneMessages } from "#harness/compaction/clone-messages.js";
import { fixedTail } from "#harness/compaction/strategies/fixed-tail/index.js";
import { type LanguageModel, type ModelMessage, streamText, type TelemetryOptions } from "ai";

import {
  CompactionInvalidResultError,
  CompactionOverLimitError,
} from "#harness/compaction/over-limit-error.js";
import { estimateTokens } from "#harness/token-estimate.js";
import { createLogger, logError } from "#internal/logging.js";
import { activeSandbox } from "#harness/attachment-staging.js";
import { AuthKey, HistoryStateKey, SandboxKey } from "#context/keys.js";
import {
  type HarnessSession,
  requireSessionModelReference,
  type StepResult,
  type ToolLoopHarnessConfig,
} from "#harness/types.js";
import {
  type HarnessModelMessage,
  isUserModelMessage,
  validateHarnessModelMessages,
} from "#harness/messages.js";
import type { Publish } from "#harness/session-machine/commit.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { Step } from "#harness/step/context.js";
import type { TurnPosition } from "#harness/session-machine/view.js";
import {
  buildGatewayAttributionHeaders,
  resolveEffectiveRuntimeModel,
  withGatewayTraceContext,
} from "#harness/model-call/model.js";
import { contextStorage } from "#context/container.js";
import { takeCompactionCaptureFailure } from "#reactions/kinds/memory.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { Cause, Usage } from "#protocol/session-events/envelope.js";
import { nextChangeId, nextRunId } from "#protocol/session-projection.js";
import { toErrorMessage } from "#shared/errors.js";
import { normalizeModelStreamError } from "#harness/model-call/errors.js";
import { runModelCallWithRetries } from "#harness/model-call/retry.js";
import {
  extractGatewayCostUsd,
  extractTokenUsageDelta,
  gatewayModelId,
  type TokenUsageDelta,
} from "#harness/model-call/usage.js";
import { resolveModelProfile } from "#harness/model-profile.js";
import { markUsageReported, NO_USAGE } from "#harness/session-usage.js";
import { addTokenUsage } from "#shared/token-usage-math.js";
import { controlDeliveryFor } from "#harness/session-machine/transitions.js";
import {
  contextStarted,
  controlAdmitted,
  deliveryApplied,
  fact,
  runRequested,
  runSettledFacts,
  runStarted,
  usageOf,
} from "#harness/facts.js";
import { openWork } from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { resolveCallProviderOptions } from "#harness/provider-safety.js";

const log = createLogger("harness.tool-loop");
/**
 * Throws when the fixed part of the request (instructions, tools, memory)
 * leaves no room for any history: compacting the history cannot help then.
 */
export function assertFixedPartFits(input: {
  readonly protectedTokens: number;
  readonly requestEnvelopeTokens: number;
  readonly threshold: number;
}): void {
  const fixed = input.requestEnvelopeTokens + input.protectedTokens;
  if (fixed >= input.threshold) {
    throw new CompactionOverLimitError(
      `The agent's system prompt, tools, memory and context take ~${Math.round(fixed)} tokens, over this model's ~${input.threshold}-token compaction limit. Shorten the instructions, remove tools or trim memory.`,
    );
  }
}

/**
 * Processes the step result: extracts input requests, decides whether to
 * park, continue the tool loop, or terminate.
 */
/** What a step needs from the machine after its model call. */
/**
 * `session.compact()`: summarizes the history now, then the session waits. The control is a
 * delivery: it's admitted with the change, and applied once the change completes.
 */
export async function compactHistory(step: Step): Promise<StepResult> {
  const { config } = step;
  const { projection } = step.view();
  const delivery = controlDeliveryFor(step.view(), config.controlDelivery);
  const { deliveryId } = delivery;
  const changeId = nextChangeId(projection);
  if (step.session.history.length === 0) {
    await step.apply([controlAdmitted(delivery, "compact"), deliveryApplied(deliveryId)]);
    return { next: null, session: step.session };
  }
  const messages = validateHarnessModelMessages(step.session.history);
  await step.apply(
    [
      controlAdmitted(delivery, "compact"),
      contextStarted({ cause: { deliveryId }, changeId, kind: "compaction" }),
    ],
    messages,
  );
  const runId = nextRunId(step.view().projection);
  let outcome: "applied" | "failed" = "applied";
  try {
    const resolvedModel = await resolveEffectiveRuntimeModel({
      config,
      ctx: step.ctx,
      session: step.session,
    });
    step.session = resolvedModel.session;
    const compacted = await maybeCompact({
      abortSignal: config.abortSignal,
      auth: step.ctx?.get(AuthKey) ?? null,
      betweenTurns: true,
      change: { announced: true, changeId, summaryRunId: runId },
      ctx: step.ctx,
      emissionState: step.position(),
      force: true,
      messages: [...step.session.history],
      model: resolvedModel.model,
      publish: step.publish,
      view: () => step.view().projection.view,
      requestEnvelopeTokens: step.session.compaction.requestEnvelopeTokens,
      resolveModel: config.resolveModel,
      runtimeIdentity: config.runtimeIdentity,
      session: step.session,
      prepareTelemetry: (runId) =>
        step.instrumentation?.prepareAttempt({ runId, attempt: 0 }).telemetry,
      strategy: config.compactionStrategy,
      traceContextHeaders: step.instrumentation?.gatewayTraceContextHeaders,
    });
    step.session = compacted.session;
    // The summary run and its change already settled failed.
    if (compacted.failure !== undefined) throw compacted.failure.error;
  } catch (error) {
    outcome = "failed";
    const facts = summaryFailed(step.view().projection.view, { changeId, error });
    if (facts.length > 0) await step.publish(facts);
    logError(log, "manual session compaction failed", error, {
      sessionId: step.session.sessionId,
    });
  }
  // Applied, not only published: the step's applied session is the compacted one.
  const reason = outcome === "failed" ? "compaction-failed" : undefined;
  await step.apply([fact("delivery.settled", { deliveryId, outcome, reason })]);
  return { next: null, session: step.session };
}

/** What a compaction's summary calls spent, together, as the summary run records it. */
function summaryUsageOf(deltas: readonly (TokenUsageDelta | undefined)[]): Usage | undefined {
  const spent = deltas.filter((delta) => delta !== undefined);
  if (spent.length === 0) return undefined;
  return spent.reduce<Usage>((total, delta) => addTokenUsage(total, usageOf(delta)), NO_USAGE);
}

/** The summary run and its change failed; the run records what it spent. */
function summaryFailed(
  view: SessionView,
  input: {
    readonly changeId: string;
    readonly error: unknown;
    readonly spent?: { readonly runId: string; readonly usage: Usage };
  },
): SessionEvent[] {
  if (view.changes[input.changeId]?.status !== "running") return [];
  const error = { code: "COMPACTION_FAILED", message: toErrorMessage(input.error) };
  // The summary run failed, and its change with it; the writer closes what else they held.
  const runs = openWork(view, { changeId: input.changeId }).runs;
  const { spent } = input;
  return [
    ...runs.flatMap(({ runId }) =>
      runSettledFacts({
        error,
        outcome: "failed",
        runId,
        ...(spent?.runId === runId && { usage: spent.usage }),
      }),
    ),
    {
      data: {
        changeId: input.changeId,
        error,
        kind: view.changes[input.changeId]?.kind ?? "compaction",
        outcome: "failed",
      },
      type: "context.settled",
    },
  ];
}

export function replaceSessionHistory(
  session: HarnessSession,
  history: HarnessModelMessage[],
): HarnessSession {
  contextStorage.getStore()?.delete(HistoryStateKey);
  return {
    ...session,
    history,
    compaction: withoutPromptMeasurement(session.compaction),
  };
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
export async function maybeCompact(
  input: Parameters<typeof compactOnce>[0],
): ReturnType<typeof compactOnce> {
  try {
    return await compactOnce(input);
  } catch (error) {
    // Setup, model resolution and history/memory preparation can fail outside the summary
    // retry loop. Close only entities actually introduced, using the latest committed view.
    const facts = summaryFailed(input.view(), { changeId: input.change.changeId, error });
    if (facts.length > 0) await input.publish(facts);
    throw error;
  }
}

async function compactOnce(input: {
  readonly abortSignal?: AbortSignal;
  readonly auth: SessionAuthContext | null;
  /** A manual compaction runs between turns, so no turn's usage reports its summary calls. */
  readonly betweenTurns?: boolean;
  /**
   * The change a compaction makes, and the run that writes its summary. `announced` when the
   * caller already published the change's start. The summary run opens with its first call.
   */
  readonly change: {
    readonly changeId: string;
    readonly summaryRunId: string;
    readonly announced?: boolean;
    readonly turnId?: string;
    readonly cause?: Cause;
  };
  /** The step's context, where a memory capture before the compaction reports failing. */
  readonly ctx?: object;
  readonly emissionState: TurnPosition;
  readonly force?: boolean;
  readonly messages: HarnessModelMessage[];
  readonly model: LanguageModel;
  readonly publish: Publish;
  readonly view: () => SessionView;
  /** Model-visible prompt used only to decide whether durable history needs compaction. */
  readonly promptMessages?: readonly HarnessModelMessage[];
  readonly requestEnvelopeTokens?: number;
  readonly resolveModel: ToolLoopHarnessConfig["resolveModel"];
  readonly runtimeIdentity?: ToolLoopHarnessConfig["runtimeIdentity"];
  readonly session: HarnessSession;
  readonly strategy?: CompactionStrategy;
  readonly telemetry?: TelemetryOptions;
  readonly prepareTelemetry?: (runId: string) => TelemetryOptions | undefined;
  readonly traceContextHeaders?: () => Record<string, string> | undefined;
}): Promise<{
  readonly compacted: boolean;
  /** The request was over the limit, so a failed compaction cannot let the model call go on. */
  readonly overLimit?: boolean;
  /** The summary failed; `session` still counts the summary calls that finished. */
  readonly failure?: { readonly error: unknown };
  readonly messages: HarnessModelMessage[];
  readonly session: HarnessSession;
}> {
  const { emissionState, publish } = input;
  const strategy = input.strategy ?? fixedTail();
  let messages = input.messages;
  let session = input.session;
  const promptMessages = input.promptMessages ?? messages;
  const projectedPromptMessages = validateHarnessModelMessages(promptMessages);
  const requestEnvelopeTokens = input.requestEnvelopeTokens ?? 0;
  const ordinary = validateHarnessModelMessages(messages);
  // Whatever the model sees besides the history (memory, client context) is kept whole, so it takes room like the envelope.
  const protectedTokens = Math.max(
    0,
    estimateTokens(projectedPromptMessages) - estimateTokens(ordinary),
  );
  const measured = {
    inputTokens: getInputTokenCount(
      projectedPromptMessages,
      session.compaction,
      input.requestEnvelopeTokens,
      session.compaction.requestEnvelopeTokens,
    ),
    recentWindowSize: session.compaction.recentWindowSize,
    requestEnvelopeTokens: requestEnvelopeTokens + protectedTokens,
    threshold: session.compaction.threshold,
  };
  const overLimit = projectedPromptMessages.length > 0 && exceedsLimit(measured);
  const needsSummary = input.force === true || overLimit;
  if (!needsSummary) {
    return { compacted: false, messages, session };
  }

  // Resolved on the first summary, so a strategy that never summarizes needs no compaction model.
  const summaryCalls = new Map<
    string | LanguageModel | undefined,
    Promise<SummaryCall & { readonly modelId: string }>
  >();
  const resolveSummaryCall = (choice: string | LanguageModel | undefined) => {
    let call = summaryCalls.get(choice);
    if (call === undefined) {
      call = (async () => {
        const model =
          choice === undefined
            ? input.model
            : typeof choice === "string"
              ? await input.resolveModel({ id: choice })
              : (resolveMockAuthoredRuntimeModel({ id: choice.modelId }) ?? choice);
        const profile = resolveModelProfile(model);
        const providerOptions = resolveCallProviderOptions({
          auth: input.auth,
          profile,
          providerOptions:
            choice === undefined
              ? requireSessionModelReference(session).providerOptions
              : undefined,
          session,
        }) as Parameters<typeof streamText>[0]["providerOptions"];
        return {
          abortSignal: input.abortSignal,
          headers: buildGatewayAttributionHeaders(profile, input.runtimeIdentity),
          model: withGatewayTraceContext(model, profile, input.traceContextHeaders),
          modelId: gatewayModelId(model) ?? "unknown",
          providerOptions,
          telemetry: input.telemetry && { ...input.telemetry, functionId: "eve.compaction" },
        };
      })();
      summaryCalls.set(choice, call);
    }
    return call;
  };
  let summaryTelemetry: TelemetryOptions | undefined;
  const summaryUsage: (TokenUsageDelta | undefined)[] = [];
  const { change } = input;
  // The summary run starts with its first call: `compactMessages` can keep the history without one.
  let summaryRunOpen = false;
  const summarize = async ({ model: choice, ...prompt }: CompactionSummaryPrompt) => {
    const { modelId, ...call } = await resolveSummaryCall(choice);
    if (!summaryRunOpen) {
      summaryRunOpen = true;
      await publish([
        runRequested({ changeId: change.changeId }, change.summaryRunId),
        runStarted({ attempt: 0, modelId, runId: change.summaryRunId }),
      ]);
    }
    const summary = await runModelCallWithRetries(
      () =>
        streamCompactionSummary({
          ...call,
          telemetry: summaryTelemetry ?? call.telemetry,
          ...prompt,
        }),
      { sessionId: session.sessionId, turnId: emissionState.turnId },
      input.abortSignal,
    );
    summaryUsage.push(summary.usage);
    if (summary.text.trim().length === 0) {
      throw new Error(
        `The compaction model returned an empty summary. Finish reason: ${summary.finishReason}.`,
      );
    }
    return summary.text;
  };

  if (change.announced !== true) {
    await publish(
      contextStarted({
        cause: change.cause,
        changeId: change.changeId,
        kind: "compaction",
        trigger: input.force === true ? undefined : { inputTokens: measured.inputTokens },
        turnId: change.turnId,
      }),
      projectedPromptMessages,
    );
  }

  if (needsSummary) summaryTelemetry = input.prepareTelemetry?.(change.summaryRunId);

  let compactedOrdinary: readonly HarnessModelMessage[] = ordinary;
  // A memory capture before compaction ran in the commit that started it. When it failed, the
  // compaction fails before it rewrites the history the capture couldn't keep.
  const captureFailure = takeCompactionCaptureFailure(input.ctx);
  let failure: { readonly error: unknown } | undefined =
    captureFailure === undefined ? undefined : { error: captureFailure };
  try {
    if (needsSummary && failure === undefined) {
      assertFixedPartFits({
        protectedTokens,
        requestEnvelopeTokens,
        threshold: session.compaction.threshold,
      });
      const context: CompactionContext = {
        ...measured,
        forced: input.force === true,
        abortSignal: input.abortSignal,
        estimateTokens,
        openSandbox: () => activeSandbox(contextStorage.getStore()?.get(SandboxKey)),
        summarize,
      };
      compactedOrdinary = await strategy.compact(cloneMessages(ordinary), context);
      validateCompactionResult(ordinary, compactedOrdinary);
      // Judged on the estimate alone: the provider's count can't say which messages its excess
      // belongs to. A compaction that was needed because the history is over its limit must
      // shrink it; one that doesn't would only run again on the next step.
      const originalEstimate = estimateTokens(ordinary);
      const resultEstimate = estimateTokens(compactedOrdinary);
      if (overLimit && resultEstimate >= originalEstimate) {
        throw new CompactionOverLimitError(
          `The compacted history is no smaller than the history (about ${resultEstimate} tokens), which is over the limit.`,
        );
      }
      const resultTokens = resultEstimate + context.requestEnvelopeTokens;
      if (exceedsLimit({ inputTokens: resultTokens, threshold: context.threshold })) {
        throw new CompactionOverLimitError(
          `The compacted history is still over the limit (about ${resultTokens} of ${context.threshold} tokens).`,
        );
      }
    }
  } catch (error) {
    failure = { error };
  }
  // What the summary calls spent belongs to the summary run, in the commit that settles it. Spent
  // between turns, no turn's report to a parent claims it.
  const usage = needsSummary ? summaryUsageOf(summaryUsage) : undefined;
  if (usage !== undefined && input.betweenTurns === true)
    session = markUsageReported(session, usage);
  const runId = change.summaryRunId;
  if (failure !== undefined) {
    await publish(
      summaryFailed(input.view(), {
        changeId: change.changeId,
        error: failure.error,
        ...(usage !== undefined && { spent: { runId, usage } }),
      }),
    );
    return { compacted: false, failure, messages: input.messages, overLimit, session };
  }
  messages = validateHarnessModelMessages(compactedOrdinary);

  {
    // Every summary call that returned left an entry, even without usage.
    const settled: SessionEvent[] =
      summaryUsage.length > 0
        ? runSettledFacts({ finishReason: "stop", outcome: "completed", runId, usage })
        : summaryRunOpen
          ? runSettledFacts({ outcome: "abandoned", runId })
          : [];
    settled.push({
      data: { changeId: change.changeId, kind: "compaction", outcome: "completed" },
      type: "context.settled",
    });
    await publish(settled, messages);
  }

  return { compacted: true, messages, session: replaceSessionHistory(session, messages) };
}

/**
 * Where a compaction during a turn leaves the turn's input: its latest user message, or that
 * message's replay. What the framework adds for the turn goes before it, as on the turn's first
 * step.
 */
export function compactedTurnInput<Message extends ModelMessage>(
  messages: readonly Message[],
): Message | undefined {
  return messages.findLast((message) => isUserModelMessage(message) && message.kind === "user");
}

type CompactionSummaryPrompt = Parameters<CompactionContext["summarize"]>[0];
type SummaryCall = Pick<
  Parameters<typeof streamText>[0],
  "abortSignal" | "headers" | "model" | "providerOptions" | "telemetry"
>;

/**
 * Calls the compaction model the way a step calls its model: streamed, with stream errors
 * thrown in the same shape, so the caller's retries classify them alike.
 */
async function streamCompactionSummary(
  input: CompactionSummaryPrompt &
    Pick<
      Parameters<typeof streamText>[0],
      "abortSignal" | "headers" | "model" | "providerOptions" | "telemetry"
    >,
): Promise<{
  readonly finishReason: string;
  readonly text: string;
  readonly usage: TokenUsageDelta | undefined;
}> {
  // The stream's error part is rethrown below; the default handler would also log it.
  const result = streamText({ ...input, onError: () => {} });
  for await (const part of result.fullStream) {
    if (part.type === "error") throw normalizeModelStreamError(part.error);
  }
  const [text, finishReason, usage, providerMetadata] = await Promise.all([
    result.text,
    result.finishReason,
    result.usage,
    result.providerMetadata,
  ]);
  return {
    finishReason,
    text,
    usage: extractTokenUsageDelta({ costUsd: extractGatewayCostUsd(providerMetadata), usage }),
  };
}

/**
 * A strategy's result must keep every tool call beside its result, keep the calls the turn is
 * waiting on, and start with a user message, or the next provider call rejects the history.
 */
function validateCompactionResult(
  original: readonly HarnessModelMessage[],
  result: readonly HarnessModelMessage[],
): void {
  const calls = (messages: readonly HarnessModelMessage[]) => toolPartIds(messages, "tool-call");
  const results = (messages: readonly HarnessModelMessage[]) =>
    toolPartIds(messages, "tool-result");
  const keptCalls = calls(result);
  const keptResults = results(result);
  for (const id of keptCalls) {
    if (!keptResults.has(id) && results(original).has(id)) {
      throw new CompactionInvalidResultError(
        `The compacted history dropped the result of tool call ${id}.`,
      );
    }
  }
  for (const id of keptResults) {
    if (!keptCalls.has(id)) {
      throw new CompactionInvalidResultError(
        `The compacted history kept the result of tool call ${id} without its call.`,
      );
    }
  }
  const waiting = [...calls(original)].filter((id) => !results(original).has(id));
  for (const id of waiting) {
    if (!keptCalls.has(id)) {
      throw new CompactionInvalidResultError(
        `The compacted history dropped tool call ${id}, which is still waiting.`,
      );
    }
  }
  const first = result[0];
  if (first !== undefined && first.role !== "user") {
    throw new CompactionInvalidResultError("The compacted history must start with a user message.");
  }
}

function toolPartIds(
  messages: readonly HarnessModelMessage[],
  type: "tool-call" | "tool-result",
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === type && "toolCallId" in part) ids.add(part.toolCallId);
    }
  }
  return ids;
}
