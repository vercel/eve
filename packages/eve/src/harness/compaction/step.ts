import { type LanguageModel, type ModelMessage, streamText, type TelemetryOptions } from "ai";

import { createLogger, logError } from "#internal/logging.js";
import { AuthKey, HistoryStateKey } from "#context/keys.js";
import {
  type CompactionConfig,
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
import type { HistoryViewProjector } from "#shared/history-view.js";
import type { Publish } from "#harness/session-machine/commit.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { Step } from "#harness/step/context.js";
import type { TurnPosition } from "#harness/session-machine/view.js";
import {
  buildGatewayAttributionHeaders,
  resolveEffectiveRuntimeModel,
  withGatewayTraceContext,
} from "#harness/model-call/model.js";
import { canonicalizeMemoryRecords, shouldCanonicalizeMemory } from "#shared/memory-state.js";
import {
  compactMessages,
  type CompactionSummarizer,
  getInputTokenCount,
  shouldCompact,
} from "#harness/compaction/engine.js";
import { contextStorage } from "#context/container.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { Cause, Usage } from "#protocol/session-events/envelope.js";
import { nextChangeId, nextRunId } from "#protocol/session-projection.js";
import { toErrorMessage } from "#shared/errors.js";
import { drainMemoryCommit, prepareMemoryCompaction } from "#context/memory-lifecycle.js";
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
import { getRequestEnvelopeTokens } from "#harness/request-envelope.js";
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
 * Processes the step result: extracts input requests, decides whether to
 * park, continue the tool loop, or terminate.
 */
/** What a step needs from the machine after its model call. */
/**
 * `session.compact()`: summarizes the history now, then the session waits. The control is a
 * delivery: it's admitted with the change, and applied once the change completes. Between turns,
 * the summary run's participants choose its model.
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
  const messages = validateHarnessModelMessages(step.projectHistory(step.session.history));
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
    await step.apply([runRequested({ changeId }, runId)], messages);
    const resolvedModel = await resolveEffectiveRuntimeModel({
      config,
      ctx: step.ctx,
      session: step.session,
    });
    step.session = resolvedModel.session;
    const summaryModel =
      step.session.agent.compactionModelReference ?? requireSessionModelReference(step.session);
    await step.publish(runStarted({ attempt: 0, modelId: summaryModel.id, runId }));
    const compacted = await maybeCompact({
      abortSignal: config.abortSignal,
      auth: step.ctx?.get(AuthKey) ?? null,
      betweenTurns: true,
      change: { announced: true, changeId, summaryRunId: runId },
      emissionState: step.position(),
      force: true,
      historyProjector: config.historyProjector,
      messages: [...step.session.history],
      model: resolvedModel.model,
      publish: step.publish,
      view: () => step.view().projection.view,
      requestEnvelopeTokens: getRequestEnvelopeTokens(step.session),
      resolveModel: config.resolveModel,
      runtimeIdentity: config.runtimeIdentity,
      session: step.session,
      prepareTelemetry: (runId) =>
        step.instrumentation?.prepareAttempt({ runId, attempt: 0 }).telemetry,
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
    compaction: {
      recentWindowSize: session.compaction.recentWindowSize,
      threshold: session.compaction.threshold,
      thresholdPercent: session.compaction.thresholdPercent,
    },
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
   * caller already published the change's start and the run's request and start.
   */
  readonly change: {
    readonly changeId: string;
    readonly summaryRunId: string;
    readonly announced?: boolean;
    readonly turnId?: string;
    readonly cause?: Cause;
  };
  readonly emissionState: TurnPosition;
  readonly force?: boolean;
  readonly historyProjector?: HistoryViewProjector;
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
  readonly telemetry?: TelemetryOptions;
  readonly prepareTelemetry?: (runId: string) => TelemetryOptions | undefined;
  readonly traceContextHeaders?: () => Record<string, string> | undefined;
}): Promise<{
  readonly compacted: boolean;
  /** The summary failed; `session` still counts the summary calls that finished. */
  readonly failure?: { readonly error: unknown };
  readonly messages: HarnessModelMessage[];
  readonly session: HarnessSession;
}> {
  const { emissionState, publish } = input;
  let messages = input.messages;
  let session = input.session;
  const promptMessages = input.promptMessages ?? messages;
  const projectedPromptMessages = validateHarnessModelMessages(
    input.historyProjector?.({ messages: promptMessages, state: session.state }) ?? promptMessages,
  );
  const needsSummary =
    input.force === true ||
    shouldCompact(
      projectedPromptMessages,
      session.compaction,
      input.requestEnvelopeTokens,
      getRequestEnvelopeTokens(session),
    );
  const needsMemoryCanonicalization = shouldCanonicalizeMemory(messages);

  if (!needsSummary && !needsMemoryCanonicalization) {
    return { compacted: false, messages, session };
  }

  const modelReference = requireSessionModelReference(session);
  const compactionModelReference = session.agent.compactionModelReference ?? modelReference;
  const model =
    compactionModelReference === modelReference
      ? input.model
      : await input.resolveModel(compactionModelReference);
  const profile = resolveModelProfile(model);
  const providerOptions = resolveCallProviderOptions({
    auth: input.auth,
    profile,
    providerOptions: compactionModelReference.providerOptions,
    session,
  }) as Parameters<typeof streamText>[0]["providerOptions"];
  const call = {
    abortSignal: input.abortSignal,
    headers: buildGatewayAttributionHeaders(profile, input.runtimeIdentity),
    model: withGatewayTraceContext(model, profile, input.traceContextHeaders),
    providerOptions,
    telemetry: input.telemetry && { ...input.telemetry, functionId: "eve.compaction" },
  };
  let summaryTelemetry: TelemetryOptions | undefined;
  const summaryUsage: (TokenUsageDelta | undefined)[] = [];
  const summarize = async (prompt: CompactionSummaryPrompt) => {
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

  const { change } = input;
  {
    const ctx = contextStorage.getStore();
    if (ctx !== undefined) {
      prepareMemoryCompaction(ctx, { history: messages, state: session.state });
    }
    if (change.announced !== true) {
      const inputTokens = getInputTokenCount(
        projectedPromptMessages,
        session.compaction,
        input.requestEnvelopeTokens,
        getRequestEnvelopeTokens(session),
      );
      await publish(
        contextStarted({
          cause: change.cause,
          changeId: change.changeId,
          kind: "compaction",
          trigger: input.force === true || inputTokens === null ? undefined : { inputTokens },
          turnId: change.turnId,
        }),
        projectedPromptMessages,
      );
      // A summary run inside a turn takes the run's model, with no participants of its own.
      if (needsSummary) {
        const runId = change.summaryRunId;
        await publish([
          runRequested({ changeId: change.changeId }, runId),
          runStarted({ attempt: 0, modelId: gatewayModelId(model) ?? "unknown", runId }),
        ]);
      }
    }
  }

  if (needsSummary) summaryTelemetry = input.prepareTelemetry?.(change.summaryRunId);

  const canonical = canonicalizeMemoryRecords(messages);
  const ordinary = validateHarnessModelMessages(
    input.historyProjector?.({ messages: canonical.ordinary, state: session.state }) ??
      canonical.ordinary,
  );
  const requestEnvelopeTokens = input.requestEnvelopeTokens ?? 0;
  const historyCompaction: CompactionConfig = {
    ...session.compaction,
    threshold: Math.max(1, session.compaction.threshold - requestEnvelopeTokens),
    lastKnownInputTokens:
      session.compaction.lastKnownInputTokens === undefined
        ? undefined
        : Math.max(
            0,
            session.compaction.lastKnownInputTokens -
              Math.min(getRequestEnvelopeTokens(session) ?? 0, requestEnvelopeTokens),
          ),
  };
  let compactedOrdinary: ModelMessage[] = [...ordinary];
  let failure: { readonly error: unknown } | undefined;
  try {
    if (needsSummary) {
      compactedOrdinary = await compactMessages(
        [...ordinary],
        historyCompaction,
        summarize,
        input.force === true,
        input.requestEnvelopeTokens === undefined
          ? undefined
          : Math.max(
              0,
              getInputTokenCount(
                projectedPromptMessages,
                session.compaction,
                requestEnvelopeTokens,
                getRequestEnvelopeTokens(session),
              ) - requestEnvelopeTokens,
            ),
      );
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
    return { compacted: false, failure, messages: input.messages, session };
  }
  messages = validateHarnessModelMessages([...canonical.memory, ...compactedOrdinary]);

  {
    const ctx = contextStorage.getStore();
    if (ctx !== undefined) {
      prepareMemoryCompaction(ctx, { history: messages, state: session.state });
    }
    const settled: SessionEvent[] = needsSummary
      ? runSettledFacts({ finishReason: "stop", outcome: "completed", runId, usage })
      : [];
    settled.push({
      data: { changeId: change.changeId, kind: "compaction", outcome: "completed" },
      type: "context.settled",
    });
    await publish(
      settled,
      input.historyProjector?.({ messages, state: session.state }) ?? messages,
    );
    if (ctx !== undefined) {
      const commit = drainMemoryCommit(ctx);
      if (commit !== undefined) {
        messages = validateHarnessModelMessages(
          placeRecalledMemory(messages, commit.recalledMessages, input.betweenTurns === true),
        );
        session = { ...session, state: commit.state };
      }
    }
  }

  return { compacted: true, messages, session: replaceSessionHistory(session, messages) };
}

/**
 * Memory recalled after a compaction during a turn goes where `turn.started` puts it: before the
 * turn's latest user message, or its replay. Between turns it follows the history, so it still
 * comes before the next turn's input.
 */
function placeRecalledMemory(
  messages: readonly ModelMessage[],
  recalled: readonly ModelMessage[],
  betweenTurns: boolean,
): ModelMessage[] {
  const index = betweenTurns
    ? -1
    : messages.findLastIndex((message) => isUserModelMessage(message) && message.kind === "user");
  if (index === -1) return [...messages, ...recalled];
  return [...messages.slice(0, index), ...recalled, ...messages.slice(index)];
}

type CompactionSummaryPrompt = Parameters<CompactionSummarizer>[0];

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
