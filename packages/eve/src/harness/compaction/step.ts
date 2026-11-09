import { type LanguageModel, type ModelMessage, streamText } from "ai";

import { CompactionOverLimitError } from "#harness/compaction/over-limit-error.js";
import { estimateTokens } from "#harness/token-estimate.js";
import { createLogger, logError } from "#internal/logging.js";
import { AuthKey } from "#context/keys.js";
import { changeHistory } from "#harness/session-machine/history.js";
import { type CompactionConfig, type StepResult } from "#harness/types.js";
import {
  type HarnessModelMessage,
  isUserModelMessage,
  validateHarnessModelMessages,
} from "#harness/messages.js";
import { type Step, stepReference } from "#harness/step/context.js";
import { agentSettings } from "#execution/effective-agent-config.js";
import { compactionConfig } from "#harness/compaction/config.js";
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
} from "#harness/compaction/engine.js";
import { takeBlockingFailure } from "#definitions/kernel.js";
import type { Usage } from "#protocol/session-events/envelope.js";
import { nextChangeId, nextRunId } from "#protocol/session-projection.js";
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
import { usageOf } from "#harness/facts.js";
import {
  completeCompaction,
  failChange,
  startChange,
  startSummaryRun,
} from "#harness/session-machine/context-changes.js";
import { admitControl, settleDelivery } from "#harness/session-machine/deliveries.js";
import { resolveCallProviderOptions } from "#harness/provider-safety.js";
import { isDeepStrictEqual } from "#platform/deep-equal.js";

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
 * `session.compact()`: summarizes the history, then the session waits. The control is a delivery:
 * it's admitted first, and applied once the history is decided.
 */
export async function compactHistory(step: Step): Promise<StepResult> {
  const { config } = step;
  const delivery = controlDeliveryFor(step.view(), config.controlDelivery);
  const { deliveryId } = delivery;
  if (step.session.history.length === 0) {
    await step.apply(admitControl(delivery, "compact", { applied: true }));
    return { next: null, session: step.session };
  }
  const messages = validateHarnessModelMessages(step.session.history);
  await step.apply(admitControl(delivery, "compact"), messages);
  const { projection } = step.view();
  const change = lazyChange(step, {
    changeId: nextChangeId(projection),
    prompt: messages,
    runId: nextRunId(projection),
    started: { cause: { deliveryId }, kind: "compaction" },
  });
  let outcome: "applied" | "failed" = "applied";
  try {
    const resolvedModel = await resolveEffectiveRuntimeModel(step);
    step.model = resolvedModel.choice;
    await summarizeHistory(step, {
      betweenTurns: true,
      change,
      compact: true,
      messages,
      model: resolvedModel.model,
      promptMessages: messages,
      requestEnvelopeTokens: step.session.compaction.requestEnvelopeTokens,
    });
  } catch (error) {
    outcome = "failed";
    logError(log, "manual session compaction failed", error, {
      sessionId: step.session.sessionId,
    });
  }
  // Applied, not only published: the step's applied session is the compacted one.
  const reason = outcome === "failed" ? "compaction-failed" : undefined;
  await step.apply(settleDelivery(deliveryId, outcome, reason));
  return { next: null, session: step.session };
}

/**
 * The history the next model call reads, committed: summarized when the call would pass the
 * threshold, a share of the model's window (`agent.ts`'s `compaction.threshold`), counting the
 * summary prompt's own overhead. Returns the messages the call reads, or `undefined` when the
 * history stays. A failure is rethrown, after settling any change it opened; `step.session`
 * counts the summary calls that finished.
 */
export async function historyBeforeCall(
  step: Step,
  input: {
    /** The durable messages the history becomes. */
    readonly messages: readonly HarnessModelMessage[];
    /** The prompt as the model reads it, which the call's size measures. */
    readonly promptMessages: readonly HarnessModelMessage[];
    readonly model: LanguageModel;
    readonly requestEnvelopeTokens: number;
  },
): Promise<HarnessModelMessage[] | undefined> {
  const prompt = validateHarnessModelMessages(input.promptMessages);
  const previousEnvelope = step.session.compaction.requestEnvelopeTokens;
  const config = compactionConfig(step);
  if (!shouldCompact(prompt, config, input.requestEnvelopeTokens, previousEnvelope)) {
    return undefined;
  }
  const tokens = getInputTokenCount(prompt, config, input.requestEnvelopeTokens, previousEnvelope);
  const { projection } = step.view();
  const turnId = step.position().turnId;
  const change = lazyChange(step, {
    changeId: nextChangeId(projection),
    prompt,
    runId: nextRunId(projection),
    started: { kind: "compaction", trigger: { inputTokens: tokens }, turnId },
  });
  return await summarizeHistory(step, {
    change,
    messages: input.messages,
    model: input.model,
    promptMessages: prompt,
    requestEnvelopeTokens: input.requestEnvelopeTokens,
    telemetryTurnId: activeTurnId(step.position()),
  });
}

/** A compaction change that opens the first time something needs it: a summary or a rewrite. */
interface LazyChange {
  readonly changeId: string;
  readonly runId: string;
  readonly opened: boolean;
  open(): Promise<void>;
}

function lazyChange(
  step: Step,
  input: {
    readonly changeId: string;
    readonly runId: string;
    readonly started: Omit<Parameters<typeof startChange>[0], "changeId">;
    readonly prompt: readonly HarnessModelMessage[];
  },
): LazyChange {
  let opened = false;
  return {
    changeId: input.changeId,
    runId: input.runId,
    get opened() {
      return opened;
    },
    async open() {
      if (opened) return;
      opened = true;
      await step.publish(startChange({ changeId: input.changeId, ...input.started }), input.prompt);
      // What blocks a compaction, such as a memory capture, ran in the commit that started it.
      // When it failed, the compaction fails before it rewrites the history.
      const captureFailure = takeBlockingFailure(step.ctx);
      if (captureFailure !== undefined) throw captureFailure;
    },
  };
}

/**
 * Compacts the history and commits it. The change opens with the first summary call or rewrite,
 * so a history with nothing to compact records none.
 */
async function summarizeHistory(
  step: Step,
  input: {
    /** Between turns, no turn's usage reports the summary calls. */
    readonly betweenTurns?: true;
    readonly change: LazyChange;
    readonly compact?: true;
    readonly messages: readonly HarnessModelMessage[];
    /** The turn's model, which writes summaries unless the agent names a compaction model. */
    readonly model: LanguageModel;
    readonly promptMessages: readonly HarnessModelMessage[];
    readonly requestEnvelopeTokens: number | undefined;
    readonly telemetryTurnId?: string;
  },
): Promise<HarnessModelMessage[] | undefined> {
  const { change } = input;
  const before = validateHarnessModelMessages(input.messages);
  const compaction = compactionConfig(step);
  const summaryUsage: (TokenUsageDelta | undefined)[] = [];
  let executor: Awaited<ReturnType<typeof summaryExecutor>> | undefined;
  let runOpen = false;
  const summarize: CompactionSummarizer = async (prompt) => {
    await change.open();
    executor ??= await summaryExecutor(step, input);
    if (!runOpen) {
      runOpen = true;
      await step.publish(
        startSummaryRun({
          changeId: change.changeId,
          modelId: executor.modelId,
          runId: change.runId,
        }),
      );
    }
    const summary = await executor.summarize(prompt);
    summaryUsage.push(summary.usage);
    if (summary.text.trim().length === 0) {
      throw new Error(
        `The compaction model returned an empty summary. Finish reason: ${summary.finishReason}.`,
      );
    }
    return summary.text;
  };

  let messages: HarnessModelMessage[];
  try {
    const rewrite = historyContext(compaction, { ...input, threshold: compaction.threshold });
    messages = (await compactMessages(
      before,
      rewrite.config,
      summarize,
      input.compact === true,
      rewrite.historyTokens,
      input.betweenTurns !== true,
    )) as HarnessModelMessage[];
    // Capping old tool output alone rewrites the history without a summary call.
    if (!isDeepStrictEqual(messages, before)) await change.open();
  } catch (error) {
    const usage = summaryUsageOf(summaryUsage);
    countSummaryUsage(step, input.betweenTurns, usage);
    if (change.opened) {
      await step.publish(
        failChange(step.view().projection.view, {
          changeId: change.changeId,
          error,
          ...(usage !== undefined && { spent: { runId: change.runId, usage } }),
        }),
      );
    }
    throw error;
  }
  const unchanged = isDeepStrictEqual(messages, before);
  if (change.opened) {
    await settleChange(step, { ...input, runOpen, summaryUsage }, unchanged ? before : messages);
  }
  if (unchanged) return undefined;
  step.session = changeHistory(step.session, { rewrite: messages });
  return messages;
}

/** Settles an open change and its summary run; what the summary calls spent belongs to the run. */
async function settleChange(
  step: Step,
  input: {
    readonly betweenTurns?: true;
    readonly change: LazyChange;
    readonly runOpen: boolean;
    readonly summaryUsage: readonly (TokenUsageDelta | undefined)[];
  },
  messages: readonly HarnessModelMessage[],
): Promise<void> {
  const { change } = input;
  const usage = summaryUsageOf(input.summaryUsage);
  countSummaryUsage(step, input.betweenTurns, usage);
  await step.publish(
    completeCompaction({
      changeId: change.changeId,
      runId: change.runId,
      runOpen: input.runOpen,
      // Every summary call that returned left an entry, even without usage.
      summarized: input.summaryUsage.length > 0,
      usage,
    }),
    messages,
  );
}

/**
 * The history's share of the threshold and of the last measurement. Whatever the model sees
 * besides the history (instructions, tools, memory, client context) is kept whole, so it takes
 * room like the envelope.
 */
function historyContext(
  compaction: CompactionConfig,
  input: {
    readonly messages: readonly HarnessModelMessage[];
    readonly promptMessages: readonly HarnessModelMessage[];
    readonly requestEnvelopeTokens: number | undefined;
    /** The call's input tokens to aim under. */
    readonly threshold: number;
  },
): { readonly config: CompactionConfig; readonly historyTokens?: number } {
  const requestEnvelopeTokens = input.requestEnvelopeTokens ?? 0;
  const protectedTokens = Math.max(
    0,
    estimateTokens(input.promptMessages) - estimateTokens(input.messages),
  );
  assertFixedPartFits({ protectedTokens, requestEnvelopeTokens, threshold: input.threshold });
  const config: CompactionConfig = {
    ...compaction,
    threshold: Math.max(1, input.threshold - requestEnvelopeTokens - protectedTokens),
    lastKnownInputTokens:
      compaction.lastKnownInputTokens === undefined
        ? undefined
        : Math.max(
            0,
            compaction.lastKnownInputTokens -
              Math.min(compaction.requestEnvelopeTokens ?? 0, requestEnvelopeTokens),
          ),
  };
  const promptTokens =
    input.requestEnvelopeTokens === undefined
      ? undefined
      : getInputTokenCount(
          input.promptMessages,
          compaction,
          requestEnvelopeTokens,
          compaction.requestEnvelopeTokens,
        );
  return {
    config,
    ...(promptTokens !== undefined && {
      historyTokens: Math.max(0, promptTokens - requestEnvelopeTokens - protectedTokens),
    }),
  };
}

/** The compaction model, called the way a step calls its model: streamed, and retried. */
async function summaryExecutor(
  step: Step,
  input: {
    readonly change: { readonly runId: string };
    readonly model: LanguageModel;
    readonly telemetryTurnId?: string;
  },
): Promise<{
  readonly modelId: string;
  summarize(prompt: CompactionSummaryPrompt): ReturnType<typeof streamCompactionSummary>;
}> {
  const { config, session } = step;
  const turnReference = stepReference(step);
  const reference = agentSettings(step).compactionModel ?? turnReference;
  const model = reference === turnReference ? input.model : await config.resolveModel(reference);
  const profile = resolveModelProfile(model);
  const call = {
    abortSignal: config.abortSignal,
    headers: buildGatewayAttributionHeaders(profile, config.runtimeIdentity),
    model: withGatewayTraceContext(
      model,
      profile,
      step.instrumentation?.gatewayTraceContextHeaders,
    ),
    providerOptions: resolveCallProviderOptions({
      auth: step.ctx.get(AuthKey) ?? null,
      profile,
      providerOptions: reference.providerOptions,
      session,
    }) as Parameters<typeof streamText>[0]["providerOptions"],
    telemetry: step.instrumentation?.prepareAttempt({
      attempt: 0,
      runId: input.change.runId,
      ...(input.telemetryTurnId !== undefined && { turnId: input.telemetryTurnId }),
    }).telemetry,
  };
  const retryScope = { sessionId: session.sessionId, turnId: step.position().turnId };
  return {
    modelId: gatewayModelId(model) ?? "unknown",
    summarize: (prompt) =>
      runModelCallWithRetries(
        () => streamCompactionSummary({ ...call, ...prompt }),
        retryScope,
        config.abortSignal,
      ),
  };
}

/** Spent between turns, no turn's report to a parent claims the summary calls. */
function countSummaryUsage(step: Step, betweenTurns: true | undefined, usage: Usage | undefined) {
  if (usage !== undefined && betweenTurns === true) {
    step.session = markUsageReported(step.session, usage);
  }
}

/** What a compaction's summary calls spent, together, as the summary run records it. */
function summaryUsageOf(deltas: readonly (TokenUsageDelta | undefined)[]): Usage | undefined {
  const spent = deltas.filter((delta) => delta !== undefined);
  if (spent.length === 0) return undefined;
  return spent.reduce<Usage>((total, delta) => addTokenUsage(total, usageOf(delta)), NO_USAGE);
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
