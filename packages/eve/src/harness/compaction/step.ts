import { type LanguageModel, type ModelMessage, streamText } from "ai";

import { createLogger, logError } from "#internal/logging.js";
import { AuthKey, HistoryStateKey } from "#context/keys.js";
import {
  type CompactionConfig,
  type HarnessSession,
  requireSessionModelReference,
  type StepResult,
} from "#harness/types.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { type HarnessModelMessage, validateHarnessModelMessages } from "#harness/messages.js";
import type { Step } from "#harness/step/context.js";
import { activeTurnId } from "#harness/session-machine/view.js";
import {
  buildGatewayAttributionHeaders,
  resolveEffectiveRuntimeModel,
  withGatewayTraceContext,
} from "#harness/model-call/model.js";
import {
  compactMessages,
  type CompactionSummarizer,
  getInputTokenCount,
  shouldCompact,
  withoutPromptMeasurement,
} from "#harness/compaction/engine.js";
import { contextStorage } from "#context/container.js";
import { takeCompactionCaptureFailure } from "#reactions/kinds/memory.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { Usage } from "#protocol/session-events/envelope.js";
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
    return { session: step.session };
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
    await summarize(step, {
      betweenTurns: true,
      change: { changeId, runId, runOpen: true },
      messages: [...step.session.history],
      model: await compactionModel(step, resolvedModel.model),
      requestEnvelopeTokens: step.session.compaction.requestEnvelopeTokens,
      trigger: "forced",
    });
  } catch (error) {
    outcome = "failed";
    // A summary that failed closed its run and change; this closes them when setup failed.
    const facts = summaryFailed(step.view().projection.view, { changeId, error });
    if (facts.length > 0) await step.publish(facts);
    logError(log, "manual session compaction failed", error, {
      sessionId: step.session.sessionId,
    });
  }
  // Applied, not only published: the step's applied session is the compacted one.
  const reason = outcome === "failed" ? "compaction-failed" : undefined;
  await step.apply([fact("delivery.settled", { deliveryId, outcome, reason })]);
  return { session: step.session };
}

/**
 * Compacts a turn's prompt before its model call when the prompt is over the threshold, and
 * returns the compacted durable messages. `undefined` when the prompt fits.
 *
 * Kept in the tool loop (rather than the AI SDK's `prepareStep` hook) so the compacted messages
 * flow through the same `messages` the harness uses to rebuild `session.history` after the step.
 */
export async function compactIfDue(
  step: Step,
  input: {
    /** The durable messages a compaction rewrites. */
    readonly messages: readonly HarnessModelMessage[];
    /** The prompt as the model reads it, which decides whether the history needs compaction. */
    readonly promptMessages: readonly HarnessModelMessage[];
    readonly model: LanguageModel;
    readonly requestEnvelopeTokens: number;
  },
): Promise<HarnessModelMessage[] | undefined> {
  const prompt = validateHarnessModelMessages(input.promptMessages);
  const { compaction } = step.session;
  const previousEnvelopeTokens = step.session.compaction.requestEnvelopeTokens;
  if (!shouldCompact(prompt, compaction, input.requestEnvelopeTokens, previousEnvelopeTokens))
    return undefined;
  const inputTokens = getInputTokenCount(
    prompt,
    compaction,
    input.requestEnvelopeTokens,
    previousEnvelopeTokens,
  );
  const { projection } = step.view();
  const change = { changeId: nextChangeId(projection), runId: nextRunId(projection) };
  const model = await compactionModel(step, input.model);
  await step.publish(
    contextStarted({
      changeId: change.changeId,
      kind: "compaction",
      trigger: { inputTokens },
      turnId: step.position().turnId,
    }),
    prompt,
  );
  return await summarize(step, {
    change: { ...change, runOpen: false },
    messages: [...input.messages],
    model,
    requestEnvelopeTokens: input.requestEnvelopeTokens,
    telemetryTurnId: activeTurnId(step.position()),
    trigger: { historyInputTokens: Math.max(0, inputTokens - input.requestEnvelopeTokens) },
  });
}

/** The model that writes summaries: the agent's compaction model, or the turn's. */
async function compactionModel(
  step: Step,
  turnModel: LanguageModel,
): Promise<{ readonly model: LanguageModel; readonly reference: RuntimeModelReference }> {
  const turnReference = requireSessionModelReference(step.session);
  const reference = step.session.agent.compactionModelReference ?? turnReference;
  return {
    model: reference === turnReference ? turnModel : await step.config.resolveModel(reference),
    reference,
  };
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
  return { ...session, history, compaction: withoutPromptMeasurement(session.compaction) };
}

/**
 * Rewrites `messages` under an announced change, then settles it and its summary run and replaces
 * the session's history. The run opens with its first summary call unless it's already open: the
 * history may compact without one. A failure settles both failed, keeps the history, and is
 * rethrown; either way `step.session` counts the summary calls that finished.
 */
async function summarize(
  step: Step,
  input: {
    /** A manual compaction runs between turns, so no turn's usage reports its summary calls. */
    readonly betweenTurns?: true;
    readonly change: {
      readonly changeId: string;
      readonly runId: string;
      readonly runOpen: boolean;
    };
    readonly messages: HarnessModelMessage[];
    readonly model: { readonly model: LanguageModel; readonly reference: RuntimeModelReference };
    readonly requestEnvelopeTokens: number | undefined;
    readonly telemetryTurnId?: string;
    /**
     * `forced` always writes a summary. A due compaction first tries model-free heuristics,
     * crediting what the history measured beyond its estimate.
     */
    readonly trigger: "forced" | { readonly historyInputTokens: number };
  },
): Promise<HarnessModelMessage[]> {
  const { change, model } = input;
  const { config } = step;
  const summaryUsage: (TokenUsageDelta | undefined)[] = [];
  let runOpen = change.runOpen;
  let compacted: ModelMessage[];
  try {
    // A memory capture before compaction ran in the commit that started it. When it failed, the
    // compaction fails before it rewrites the history the capture couldn't keep.
    const captureFailure = takeCompactionCaptureFailure(step.ctx);
    if (captureFailure !== undefined) throw captureFailure;
    const profile = resolveModelProfile(model.model);
    const call = {
      abortSignal: config.abortSignal,
      headers: buildGatewayAttributionHeaders(profile, config.runtimeIdentity),
      model: withGatewayTraceContext(
        model.model,
        profile,
        step.instrumentation?.gatewayTraceContextHeaders,
      ),
      providerOptions: resolveCallProviderOptions({
        auth: step.ctx?.get(AuthKey) ?? null,
        profile,
        providerOptions: model.reference.providerOptions,
        session: step.session,
      }) as Parameters<typeof streamText>[0]["providerOptions"],
      telemetry: step.instrumentation?.prepareAttempt({
        attempt: 0,
        runId: change.runId,
        ...(input.telemetryTurnId !== undefined && { turnId: input.telemetryTurnId }),
      }).telemetry,
    };
    const retryScope = { sessionId: step.session.sessionId, turnId: step.position().turnId };
    compacted = await compactMessages(
      validateHarnessModelMessages(input.messages),
      historyCompactionConfig(step.session, input.requestEnvelopeTokens),
      async (prompt) => {
        if (!runOpen) {
          runOpen = true;
          await step.publish([
            runRequested({ changeId: change.changeId }, change.runId),
            runStarted({
              attempt: 0,
              modelId: gatewayModelId(model.model) ?? "unknown",
              runId: change.runId,
            }),
          ]);
        }
        const summary = await runModelCallWithRetries(
          () => streamCompactionSummary({ ...call, ...prompt }),
          retryScope,
          config.abortSignal,
        );
        summaryUsage.push(summary.usage);
        if (summary.text.trim().length === 0) {
          throw new Error(
            `The compaction model returned an empty summary. Finish reason: ${summary.finishReason}.`,
          );
        }
        return summary.text;
      },
      input.trigger === "forced",
      input.trigger === "forced" ? undefined : input.trigger.historyInputTokens,
    );
  } catch (error) {
    const usage = summaryUsageOf(summaryUsage);
    countSummaryUsage(step, input.betweenTurns, usage);
    await step.publish(
      summaryFailed(step.view().projection.view, {
        changeId: change.changeId,
        error,
        ...(usage !== undefined && { spent: { runId: change.runId, usage } }),
      }),
    );
    throw error;
  }
  // What the summary calls spent belongs to the summary run, in the commit that settles it.
  const usage = summaryUsageOf(summaryUsage);
  countSummaryUsage(step, input.betweenTurns, usage);
  const messages = validateHarnessModelMessages(compacted);
  await step.publish(
    [
      // Every summary call that returned left an entry, even without usage.
      ...(summaryUsage.length > 0
        ? runSettledFacts({
            finishReason: "stop",
            outcome: "completed",
            runId: change.runId,
            usage,
          })
        : runOpen
          ? runSettledFacts({ outcome: "abandoned", runId: change.runId })
          : []),
      {
        data: { changeId: change.changeId, kind: "compaction", outcome: "completed" },
        type: "context.settled",
      },
    ],
    messages,
  );
  step.session = replaceSessionHistory(step.session, messages);
  return messages;
}

/** Spent between turns, no turn's report to a parent claims the summary calls. */
function countSummaryUsage(step: Step, betweenTurns: true | undefined, usage: Usage | undefined) {
  if (usage !== undefined && betweenTurns === true)
    step.session = markUsageReported(step.session, usage);
}

/**
 * The threshold and measurement for the history alone: the request envelope around it is not
 * the history's to shrink.
 */
function historyCompactionConfig(
  session: HarnessSession,
  requestEnvelopeTokens = 0,
): CompactionConfig {
  const { compaction } = session;
  return {
    ...compaction,
    threshold: Math.max(1, compaction.threshold - requestEnvelopeTokens),
    lastKnownInputTokens:
      compaction.lastKnownInputTokens === undefined
        ? undefined
        : Math.max(
            0,
            compaction.lastKnownInputTokens -
              Math.min(session.compaction.requestEnvelopeTokens ?? 0, requestEnvelopeTokens),
          ),
  };
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
