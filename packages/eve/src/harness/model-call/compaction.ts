import type { LanguageModel, TelemetryOptions } from "ai";

import { createLogger, logError } from "#internal/logging.js";
import { AuthKey, HistoryStateKey } from "#context/keys.js";
import {
  type CompactionConfig,
  type HarnessSession,
  requireSessionModelReference,
  type StepResult,
  type ToolLoopHarnessConfig,
} from "#harness/types.js";
import { type HarnessModelMessage, validateHarnessModelMessages } from "#harness/messages.js";
import type { HistoryViewProjector } from "#shared/history-view.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { Step } from "#harness/step/context.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import {
  buildGatewayAttributionHeaders,
  resolveEffectiveRuntimeModel,
} from "#harness/model-call/model.js";
import { canonicalizeMemoryRecords, shouldCanonicalizeMemory } from "#shared/memory-state.js";
import {
  compactMessages,
  getInputTokenCount,
  resolveCompactionModel,
  shouldCompact,
} from "#harness/compaction.js";
import { contextStorage } from "#context/container.js";
import {
  createCompactionCompletedEvent,
  createCompactionRequestedEvent,
} from "#protocol/message.js";
import { drainMemoryCommit, prepareMemoryCompaction } from "#context/memory-lifecycle.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import { createSessionWaitingEvent } from "#protocol/message.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import { getRequestEnvelopeTokens } from "#harness/request-envelope.js";
import { resolveCallProviderOptions } from "#harness/provider-safety.js";
import { resolveConversationId } from "#shared/conversation-identity.js";

const log = createLogger("harness.tool-loop");
/** `session.compact()`: summarizes the history now, then the session waits. */
export async function compactHistory(step: Step): Promise<StepResult> {
  const { config } = step;
  if (step.session.history.length > 0) {
    try {
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
        emissionState: { ...position, turnId: activeTurnId(position) },
        force: true,
        historyProjector: config.historyProjector,
        messages: [...step.session.history],
        model: resolvedModel.model,
        emit: step.emit,
        requestEnvelopeTokens: getRequestEnvelopeTokens(step.session),
        resolveModel: config.resolveModel,
        runtimeIdentity: config.runtimeIdentity,
        session: step.session,
        telemetry: step.instrumentation?.telemetry(),
      });
      step.session = compacted.session;
    } catch (error) {
      logError(log, "manual session compaction failed", error, {
        sessionId: step.session.sessionId,
      });
    }
  }
  await step.emit?.(createSessionWaitingEvent(getSessionUsage(step.session)));
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
  readonly emissionState: HarnessEmissionState;
  readonly emit?: ToolLoopHarnessConfig["handleEvent"];
  readonly force?: boolean;
  readonly historyProjector?: HistoryViewProjector;
  readonly messages: HarnessModelMessage[];
  readonly model: LanguageModel;
  /** Model-visible prompt used only to decide whether durable history needs compaction. */
  readonly promptMessages?: readonly HarnessModelMessage[];
  readonly requestEnvelopeTokens?: number;
  readonly resolveModel: ToolLoopHarnessConfig["resolveModel"];
  readonly runtimeIdentity?: ToolLoopHarnessConfig["runtimeIdentity"];
  readonly session: HarnessSession;
  readonly telemetry?: TelemetryOptions;
}): Promise<{
  readonly compacted: boolean;
  readonly messages: HarnessModelMessage[];
  readonly session: HarnessSession;
}> {
  const { emissionState, emit } = input;
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

  const compaction = await resolveCompactionModel({
    compactionModelReference: session.agent.compactionModelReference,
    model: input.model,
    modelReference: requireSessionModelReference(session),
    resolveModel: input.resolveModel,
  });
  const compactionModelReference =
    session.agent.compactionModelReference ?? requireSessionModelReference(session);
  const providerOptions = resolveCallProviderOptions({
    auth: input.auth,
    conversationId: resolveConversationId(session.rootSessionId ?? session.sessionId),
    model: compaction.model,
    modelReference: compactionModelReference,
    providerOptions: compaction.providerOptions,
  }) as Parameters<typeof compactMessages>[3];

  if (emit) {
    const ctx = contextStorage.getStore();
    if (ctx !== undefined) {
      prepareMemoryCompaction(ctx, { history: messages, state: session.state });
    }
    await emit(
      createCompactionRequestedEvent({
        modelId: formatLanguageModelGatewayId(compaction.model),
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
  const compactedOrdinary = needsSummary
    ? await compactMessages(
        [...ordinary],
        compaction.model,
        historyCompaction,
        providerOptions,
        input.telemetry,
        buildGatewayAttributionHeaders(compaction.model, input.runtimeIdentity),
        input.abortSignal,
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
      )
    : [...ordinary];
  messages = validateHarnessModelMessages([...canonical.memory, ...compactedOrdinary]);

  if (emit) {
    const ctx = contextStorage.getStore();
    if (ctx !== undefined) {
      prepareMemoryCompaction(ctx, { history: messages, state: session.state });
    }
    await emit(
      createCompactionCompletedEvent({
        modelId: formatLanguageModelGatewayId(compaction.model),
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
        messages = validateHarnessModelMessages([...messages, ...commit.recalledMessages]);
        session = { ...session, state: commit.state };
      }
    }
  }

  return { compacted: true, messages, session: replaceSessionHistory(session, messages) };
}
