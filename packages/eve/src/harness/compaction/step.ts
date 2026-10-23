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
import { activeTurnId, type TurnPosition } from "#harness/session-machine/view.js";
import { stepStartedForResolvers } from "#harness/session-machine/resolver-events.js";
import {
  buildGatewayAttributionHeaders,
  resolveEffectiveRuntimeModel,
  withGatewayTraceContext,
} from "#harness/model-call/model.js";
import { canonicalizeMemoryRecords, shouldCanonicalizeMemory } from "#shared/memory-state.js";
import { estimateTokens, MAX_TEXT_SCALE } from "#harness/token-estimate.js";
import {
  compactMessages,
  type CompactionSummarizer,
  getInputTokenCount,
  shouldCompact,
} from "#harness/compaction/engine.js";
import { contextStorage } from "#context/container.js";
import {
  createCompactionCompletedEvent,
  createCompactionRequestedEvent,
} from "#protocol/message.js";
import { drainMemoryCommit, prepareMemoryCompaction } from "#context/memory-lifecycle.js";
import { normalizeModelStreamError } from "#harness/model-call/errors.js";
import { runModelCallWithRetries } from "#harness/model-call/retry.js";
import {
  extractGatewayCostUsd,
  extractTokenUsageDelta,
  gatewayModelId,
} from "#harness/model-call/usage.js";
import { resolveModelProfile } from "#harness/model-profile.js";
import {
  addTurnUsage,
  addUsageOutsideTurns,
  type TokenUsageDelta,
} from "#harness/turn-tag-state.js";
import { getRequestEnvelopeTokens } from "#harness/request-envelope.js";
import { idle } from "#harness/session-machine/transitions.js";
import { resolveCallProviderOptions } from "#harness/provider-safety.js";

const log = createLogger("harness.tool-loop");
/**
 * Processes the step result: extracts input requests, decides whether to
 * park, continue the tool loop, or terminate.
 */
/** What a step needs from the machine after its model call. */
/** `session.compact()`: summarizes the history now, then the session waits. */
export async function compactHistory(step: Step): Promise<StepResult> {
  const { config } = step;
  if (step.session.history.length > 0) {
    try {
      if (step.ctx !== undefined && config.dispatchDynamicModelEvent !== undefined) {
        const position = step.position();
        await config.dispatchDynamicModelEvent({
          ctx: step.ctx,
          event: stepStartedForResolvers({
            modelId: step.session.agent.modelReference?.id ?? "dynamic",
            sequence: position.sequence,
            stepIndex: position.stepIndex,
            turnId: activeTurnId(position),
          }),
          messages: validateHarnessModelMessages(step.projectHistory(step.session.history)),
        });
      }
      const resolvedModel = await resolveEffectiveRuntimeModel({
        config,
        ctx: step.ctx,
        session: step.session,
      });
      step.session = resolvedModel.session;
      const position = step.position();
      const compacted = await maybeCompact({
        abortSignal: config.abortSignal,
        auth: step.ctx?.get(AuthKey) ?? null,
        betweenTurns: true,
        emissionState: { ...position, turnId: activeTurnId(position) },
        force: true,
        historyProjector: config.historyProjector,
        messages: [...step.session.history],
        model: resolvedModel.model,
        publish: step.publish,
        requestEnvelopeTokens: getRequestEnvelopeTokens(step.session),
        resolveModel: config.resolveModel,
        runtimeIdentity: config.runtimeIdentity,
        session: step.session,
        telemetry: step.instrumentation?.telemetry(),
        traceContextHeaders: step.instrumentation?.gatewayTraceContextHeaders,
      });
      step.session = compacted.session;
      if (compacted.failure !== undefined) throw compacted.failure.error;
    } catch (error) {
      logError(log, "manual session compaction failed", error, {
        sessionId: step.session.sessionId,
      });
    }
  }
  await step.apply(idle(step.view()));
  return { next: null, session: step.session };
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
 * Restates the provider's last token count for the history `compactMessages`
 * sees. The count covers the whole projected prompt, memory records included,
 * but compaction works on the ordinary messages only, and memory records stay
 * in the history verbatim. So: find the provider-to-estimate ratio over the
 * prompt it measured, then hand compaction (1) how many ordinary messages that
 * covered and the tokens they cost at that ratio, and (2) a threshold with the
 * memory records' tokens, at that ratio, and the request envelope taken off.
 */
export function describeHistoryForCompaction(input: {
  readonly compaction: CompactionConfig;
  readonly memory: readonly ModelMessage[];
  readonly ordinary: readonly ModelMessage[];
  readonly previousEnvelopeTokens: number;
  /** The history the prompt was projected from, before memory attribution was stripped. */
  readonly promptSource: readonly ModelMessage[];
  readonly projectedPrompt: readonly HarnessModelMessage[];
  readonly requestEnvelopeTokens: number;
}): CompactionConfig {
  const { compaction, ordinary, projectedPrompt, requestEnvelopeTokens } = input;
  const providerTokens =
    compaction.lastKnownInputTokens === undefined
      ? undefined
      : Math.max(
          0,
          compaction.lastKnownInputTokens -
            Math.min(input.previousEnvelopeTokens, requestEnvelopeTokens),
        );
  const count = compaction.lastKnownPromptMessageCount;
  const measuredPrompt =
    providerTokens !== undefined &&
    count !== undefined &&
    Number.isInteger(count) &&
    count > 0 &&
    count <= projectedPrompt.length
      ? projectedPrompt.slice(0, count)
      : undefined;
  const promptEstimate = measuredPrompt === undefined ? 0 : estimateTokens(measuredPrompt);
  const scale =
    providerTokens !== undefined && promptEstimate > 0
      ? Math.max(1, providerTokens / promptEstimate)
      : 1;
  // Projection passes ordinary messages through as they are and rebuilds the
  // memory records it keeps, so the ordinary messages the provider measured
  // are the ones still in the source history.
  const source = new Set<ModelMessage>(input.promptSource);
  const measuredCount =
    measuredPrompt === undefined
      ? undefined
      : Math.min(measuredPrompt.filter((message) => source.has(message)).length, ordinary.length);
  const threshold = Math.max(
    1,
    compaction.threshold -
      requestEnvelopeTokens -
      estimateTokens(input.memory) * Math.min(scale, MAX_TEXT_SCALE),
  );
  if (measuredCount === undefined || measuredCount === 0) {
    return {
      ...compaction,
      lastKnownInputTokens: undefined,
      lastKnownPromptMessageCount: undefined,
      threshold,
    };
  }
  return {
    ...compaction,
    lastKnownInputTokens: estimateTokens(ordinary.slice(0, measuredCount)) * scale,
    lastKnownPromptMessageCount: measuredCount,
    threshold,
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
export async function maybeCompact(input: {
  readonly abortSignal?: AbortSignal;
  readonly auth: SessionAuthContext | null;
  /** A manual compaction runs between turns, so no turn's usage reports its summary calls. */
  readonly betweenTurns?: boolean;
  readonly emissionState: TurnPosition;
  readonly force?: boolean;
  readonly historyProjector?: HistoryViewProjector;
  readonly messages: HarnessModelMessage[];
  readonly model: LanguageModel;
  readonly publish: Publish;
  /** Model-visible prompt used only to decide whether durable history needs compaction. */
  readonly promptMessages?: readonly HarnessModelMessage[];
  readonly requestEnvelopeTokens?: number;
  readonly resolveModel: ToolLoopHarnessConfig["resolveModel"];
  readonly runtimeIdentity?: ToolLoopHarnessConfig["runtimeIdentity"];
  readonly session: HarnessSession;
  readonly telemetry?: TelemetryOptions;
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
  const summaryUsage: (TokenUsageDelta | undefined)[] = [];
  const summarize = async (prompt: CompactionSummaryPrompt) => {
    const summary = await runModelCallWithRetries(
      () => streamCompactionSummary({ ...call, ...prompt }),
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

  {
    const ctx = contextStorage.getStore();
    if (ctx !== undefined) {
      prepareMemoryCompaction(ctx, { history: messages, state: session.state });
    }
    await publish(
      createCompactionRequestedEvent({
        modelId: gatewayModelId(model) ?? "unknown",
        sequence: emissionState.sequence,
        sessionId: session.sessionId,
        stepIndex: emissionState.stepIndex,
        turnId: emissionState.turnId,
        usageInputTokens: getInputTokenCount(
          projectedPromptMessages,
          session.compaction,
          input.requestEnvelopeTokens,
          getRequestEnvelopeTokens(session),
        ),
      }),
      projectedPromptMessages,
    );
  }

  const canonical = canonicalizeMemoryRecords(messages);
  const ordinary = validateHarnessModelMessages(
    input.historyProjector?.({ messages: canonical.ordinary, state: session.state }) ??
      canonical.ordinary,
  );
  const historyCompaction = describeHistoryForCompaction({
    compaction: session.compaction,
    memory: canonical.memory,
    ordinary,
    previousEnvelopeTokens: getRequestEnvelopeTokens(session) ?? 0,
    promptSource: promptMessages,
    projectedPrompt: projectedPromptMessages,
    requestEnvelopeTokens: input.requestEnvelopeTokens ?? 0,
  });
  let compactedOrdinary: ModelMessage[] = [...ordinary];
  let failure: { readonly error: unknown } | undefined;
  try {
    if (needsSummary) {
      compactedOrdinary = await compactMessages(
        [...ordinary],
        historyCompaction,
        summarize,
        input.force === true,
      );
    }
  } catch (error) {
    failure = { error };
  }
  for (const usage of summaryUsage) {
    session =
      input.betweenTurns === true
        ? addUsageOutsideTurns(session, usage)
        : addTurnUsage(session, emissionState.turnId, usage);
  }
  if (failure !== undefined) {
    return { compacted: false, failure, messages: input.messages, session };
  }
  messages = validateHarnessModelMessages([...canonical.memory, ...compactedOrdinary]);

  {
    const ctx = contextStorage.getStore();
    if (ctx !== undefined) {
      prepareMemoryCompaction(ctx, { history: messages, state: session.state });
    }
    await publish(
      createCompactionCompletedEvent({
        modelId: gatewayModelId(model) ?? "unknown",
        sequence: emissionState.sequence,
        sessionId: session.sessionId,
        stepIndex: emissionState.stepIndex,
        turnId: emissionState.turnId,
      }),
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
