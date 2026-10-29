import { type LanguageModel, type ModelMessage, streamText } from "ai";

import { CompactionOverLimitError } from "#harness/compaction/over-limit-error.js";
import { estimateTokens } from "#harness/token-estimate.js";
import { createLogger, logError } from "#internal/logging.js";
import { AuthKey } from "#context/keys.js";
import { changeHistory } from "#harness/session-machine/history.js";
import { authoredRewrite } from "#harness/compaction/authored.js";
import type { PublicAgentStaticModelDefinition } from "#shared/agent-definition.js";
import {
  type CompactionConfig,
  type HarnessSession,
  requireSessionModelReference,
  type StepResult,
} from "#harness/types.js";
import {
  type HarnessModelMessage,
  isUserModelMessage,
  validateHarnessModelMessages,
} from "#harness/messages.js";
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
} from "#harness/compaction/engine.js";
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
    await rewriteHistory(step, {
      betweenTurns: true,
      change: { changeId, runId, runOpen: true },
      force: true,
      messages,
      model: resolvedModel.model,
      promptMessages: messages,
      requestEnvelopeTokens: step.session.compaction.requestEnvelopeTokens,
    });
  } catch (error) {
    outcome = "failed";
    // A rewrite that failed closed its run and change; this closes them when setup failed.
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

/**
 * Compacts a turn's prompt before its model call when the prompt is over the threshold, and
 * returns the compacted durable messages: `undefined` when the prompt fits. A failure settles
 * the change failed and is rethrown; `step.session` counts the summary calls that finished.
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
  const previousEnvelopeTokens = compaction.requestEnvelopeTokens;
  if (!shouldCompact(prompt, compaction, input.requestEnvelopeTokens, previousEnvelopeTokens)) {
    return undefined;
  }
  const { projection } = step.view();
  const change = { changeId: nextChangeId(projection), runId: nextRunId(projection) };
  try {
    const inputTokens = getInputTokenCount(
      prompt,
      compaction,
      input.requestEnvelopeTokens,
      previousEnvelopeTokens,
    );
    await step.publish(
      contextStarted({
        changeId: change.changeId,
        kind: "compaction",
        trigger: { inputTokens },
        turnId: step.position().turnId,
      }),
      prompt,
    );
    return await rewriteHistory(step, {
      change: { ...change, runOpen: false },
      force: false,
      messages: input.messages,
      model: input.model,
      promptMessages: prompt,
      requestEnvelopeTokens: input.requestEnvelopeTokens,
      telemetryTurnId: activeTurnId(step.position()),
    });
  } catch (error) {
    // Setup can fail before the rewrite closes what it opened: close only what's still open.
    const facts = summaryFailed(step.view().projection.view, { changeId: change.changeId, error });
    if (facts.length > 0) await step.publish(facts);
    throw error;
  }
}

/** What a history rewrite reads and calls while its change is open. */
export interface HistoryRewriteContext {
  readonly abortSignal: AbortSignal;
  readonly changeId: string;
  readonly sessionId: string;
  /** Always summarize: `session.compact()` asked, rather than a threshold. */
  readonly force: boolean;
  /** The threshold and measurement for the history alone, without what surrounds it. */
  readonly config: CompactionConfig;
  /** The history's tokens as the provider last measured them, when known. */
  readonly historyTokens?: number;
  /** Writes a summary with the compaction model, under the change's summary run. */
  readonly summarize: CompactionSummarizer;
  /** Writes a summary with `model`, or the compaction model, under the same run. */
  summarizeWith(model?: PublicAgentStaticModelDefinition): CompactionSummarizer;
}

/**
 * Rewrites the history under an open change: eve's default summarizes older turns. `undefined`
 * leaves the history as it is.
 */
export type HistoryRewrite = (
  messages: HarnessModelMessage[],
  ctx: HistoryRewriteContext,
) => Promise<readonly ModelMessage[] | undefined>;

const defaultRewrite: HistoryRewrite = (messages, ctx) =>
  compactMessages(messages, ctx.config, ctx.summarize, ctx.force, ctx.historyTokens);

/**
 * Rewrites `messages` under an announced change, then settles it and its summary run and replaces
 * the session's history. The run opens with its first summary call unless it's already open: the
 * history may compact without one. A failure settles both failed, keeps the history, and is
 * rethrown; either way `step.session` counts the summary calls that finished.
 */
async function rewriteHistory(
  step: Step,
  input: {
    /** A manual compaction runs between turns, so no turn's usage reports its summary calls. */
    readonly betweenTurns?: true;
    readonly change: {
      readonly changeId: string;
      readonly runId: string;
      readonly runOpen: boolean;
    };
    readonly force: boolean;
    readonly messages: readonly HarnessModelMessage[];
    /** The turn's model, which writes summaries unless the agent names a compaction model. */
    readonly model: LanguageModel;
    readonly promptMessages: readonly HarnessModelMessage[];
    readonly requestEnvelopeTokens: number | undefined;
    readonly telemetryTurnId?: string;
  },
): Promise<HarnessModelMessage[]> {
  const { change } = input;
  const summaryUsage: (TokenUsageDelta | undefined)[] = [];
  const executor = await summaryExecutor(step, input);
  let runOpen = change.runOpen;
  const executors = new Map<PublicAgentStaticModelDefinition, ReturnType<typeof summaryExecutor>>();
  const executorFor = (model: PublicAgentStaticModelDefinition) => {
    const known = executors.get(model) ?? summaryExecutor(step, input, model);
    executors.set(model, known);
    return known;
  };
  const summarizeWith =
    (model?: PublicAgentStaticModelDefinition): CompactionSummarizer =>
    async (prompt) => {
      const chosen = model === undefined ? executor : await executorFor(model);
      if (!runOpen) {
        runOpen = true;
        await step.publish([
          runRequested({ changeId: change.changeId }, change.runId),
          runStarted({ attempt: 0, modelId: chosen.modelId, runId: change.runId }),
        ]);
      }
      const summary = await chosen.summarize(prompt);
      summaryUsage.push(summary.usage);
      if (summary.text.trim().length === 0) {
        throw new Error(
          `The compaction model returned an empty summary. Finish reason: ${summary.finishReason}.`,
        );
      }
      return summary.text;
    };
  const strategy = step.config.compactionStrategy;
  const rewrite = strategy === undefined ? defaultRewrite : authoredRewrite(strategy);

  let rewritten: readonly ModelMessage[] | undefined;
  try {
    // A memory capture before compaction ran in the commit that started it. When it failed, the
    // compaction fails before it rewrites the history the capture couldn't keep.
    const captureFailure = takeCompactionCaptureFailure(step.ctx);
    if (captureFailure !== undefined) throw captureFailure;
    rewritten = await rewrite(validateHarnessModelMessages(input.messages), {
      ...historyContext(step.session, { ...input, summarize: summarizeWith() }),
      abortSignal: step.config.abortSignal ?? new AbortController().signal,
      changeId: change.changeId,
      sessionId: step.session.sessionId,
      summarizeWith,
    });
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
  const messages = validateHarnessModelMessages(rewritten ?? input.messages);
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
  if (rewritten !== undefined) step.session = changeHistory(step.session, { rewrite: messages });
  return messages;
}

/**
 * The history's share of the threshold and of the last measurement. Whatever the model sees
 * besides the history (instructions, tools, memory, client context) is kept whole, so it takes
 * room like the envelope.
 */
function historyContext(
  session: HarnessSession,
  input: {
    readonly force: boolean;
    readonly messages: readonly HarnessModelMessage[];
    readonly promptMessages: readonly HarnessModelMessage[];
    readonly requestEnvelopeTokens: number | undefined;
    readonly summarize: CompactionSummarizer;
  },
): Pick<HistoryRewriteContext, "config" | "force" | "historyTokens" | "summarize"> {
  const { compaction } = session;
  const requestEnvelopeTokens = input.requestEnvelopeTokens ?? 0;
  const protectedTokens = Math.max(
    0,
    estimateTokens(input.promptMessages) - estimateTokens(input.messages),
  );
  assertFixedPartFits({ protectedTokens, requestEnvelopeTokens, threshold: compaction.threshold });
  const config: CompactionConfig = {
    ...compaction,
    threshold: Math.max(1, compaction.threshold - requestEnvelopeTokens - protectedTokens),
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
    force: input.force,
    ...(promptTokens !== undefined && {
      historyTokens: Math.max(0, promptTokens - requestEnvelopeTokens - protectedTokens),
    }),
    summarize: input.summarize,
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
  /** A strategy's own summary model, instead of the agent's compaction model or the turn's. */
  override?: PublicAgentStaticModelDefinition,
): Promise<{
  readonly modelId: string;
  summarize(prompt: CompactionSummaryPrompt): ReturnType<typeof streamCompactionSummary>;
}> {
  const { config, session } = step;
  const turnReference = requireSessionModelReference(session);
  const reference =
    typeof override === "string"
      ? { id: override }
      : (session.agent.compactionModelReference ?? turnReference);
  const model =
    override !== undefined && typeof override !== "string"
      ? (override as LanguageModel)
      : reference === turnReference
        ? input.model
        : await config.resolveModel(reference);
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
      auth: step.ctx?.get(AuthKey) ?? null,
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
