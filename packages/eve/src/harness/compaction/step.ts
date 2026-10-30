import { type LanguageModel, type ModelMessage, streamText } from "ai";

import { CompactionOverLimitError } from "#harness/compaction/over-limit-error.js";
import { estimateTokens } from "#harness/token-estimate.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { createLogger, logError } from "#internal/logging.js";
import { AuthKey } from "#context/keys.js";
import { changeHistory } from "#harness/session-machine/history.js";
import {
  strategyHistory,
  type StrategyContext,
  type SummaryCall,
  triggersAt,
} from "#harness/compaction/authored.js";
import type {
  CompactionMeasure,
  CompactionPhase,
  CompactionReason,
} from "#shared/compaction-strategy.js";
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
} from "#harness/compaction/engine.js";
import { takeCompactionCaptureFailure } from "#reactions/kinds/memory.js";
import { programHistory } from "#harness/program/kernel.js";
import { nativeThreshold } from "#harness/program/native.js";
import { checkHistory } from "#harness/program/check.js";
import type { HistorySize, ProgramContext, Summarize } from "#harness/program/program.js";
import { checksHistory } from "#harness/session-machine/history.js";
import { isDeepStrictEqual } from "node:util";
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
 * `session.compact()`: asks the session's program for the history with a compaction requested,
 * then the session waits. The control is a delivery: it's admitted first, and applied once the
 * history is decided.
 */
export async function compactHistory(step: Step): Promise<StepResult> {
  const { config } = step;
  const delivery = controlDeliveryFor(step.view(), config.controlDelivery);
  const { deliveryId } = delivery;
  if (step.session.history.length === 0) {
    await step.apply([controlAdmitted(delivery, "compact"), deliveryApplied(deliveryId)]);
    return { next: null, session: step.session };
  }
  const messages = validateHarnessModelMessages(step.session.history);
  await step.apply([controlAdmitted(delivery, "compact")], messages);
  const { projection } = step.view();
  const change = lazyChange(step, {
    changeId: nextChangeId(projection),
    prompt: messages,
    runId: nextRunId(projection),
    started: { cause: { deliveryId }, kind: "compaction" },
  });
  let outcome: "applied" | "failed" = "applied";
  try {
    const resolvedModel = await resolveEffectiveRuntimeModel({
      config,
      ctx: step.ctx,
      session: step.session,
    });
    step.session = resolvedModel.session;
    const { compaction } = step.session;
    const envelope = compaction.requestEnvelopeTokens;
    await decideHistory(step, {
      betweenTurns: true,
      change,
      compact: true,
      messages,
      model: resolvedModel.model,
      phase: "manual",
      promptMessages: messages,
      reason: "manual",
      requestEnvelopeTokens: envelope,
      size: sizeOf(step.session, getInputTokenCount(messages, compaction, envelope, envelope)),
    });
  } catch (error) {
    outcome = "failed";
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
 * Asks the session's program for the history the next model call reads, and commits it: the
 * messages the call reads, or `undefined` when the history stays. A failure is rethrown, after settling any change it opened; `step.session` counts the summary calls that
 * finished.
 */
export async function historyBeforeCall(
  step: Step,
  input: {
    /** The durable messages the history becomes. */
    readonly messages: readonly HarnessModelMessage[];
    /** The prompt as the model reads it, which the call's size measures. */
    readonly promptMessages: readonly HarnessModelMessage[];
    readonly model: LanguageModel;
    /** What the request starts with: its instructions and tools. */
    readonly request: StrategyContext["request"];
    readonly requestEnvelopeTokens: number;
    /** The provider rejected the request as too long: compact whatever the trigger says. */
    readonly overflow?: true;
  },
): Promise<HarnessModelMessage[] | undefined> {
  const overflow = input.overflow === true;
  const prompt = validateHarnessModelMessages(input.promptMessages);
  const { compaction } = step.session;
  const size = sizeOf(
    step.session,
    getInputTokenCount(
      prompt,
      compaction,
      input.requestEnvelopeTokens,
      compaction.requestEnvelopeTokens,
    ),
  );
  const { projection } = step.view();
  const turnId = step.position().turnId;
  const change = lazyChange(step, {
    changeId: nextChangeId(projection),
    prompt,
    runId: nextRunId(projection),
    started: { kind: "compaction", trigger: { inputTokens: size.tokens }, turnId },
  });
  return await decideHistory(step, {
    change,
    ...(overflow && { compact: true as const }),
    messages: input.messages,
    model: input.model,
    phase: "step",
    promptMessages: prompt,
    reason: overflow ? "overflow" : "automatic",
    request: input.request,
    requestEnvelopeTokens: input.requestEnvelopeTokens,
    size,
    telemetryTurnId: activeTurnId(step.position()),
  });
}

/**
 * Compacts the history after the turn's answer, before the turn settles, when the agent's
 * strategy asks at `turn-end` and is due. The answer stands either way: a failure settles the
 * change failed, is logged, and keeps the history.
 */
export async function compactAtTurnEnd(step: Step): Promise<void> {
  if (!triggersAt(step.config.compactionStrategy, "turn-end")) return;
  if (step.session.history.length === 0) return;
  const { compaction } = step.session;
  const envelope = compaction.requestEnvelopeTokens ?? 0;
  const messages = validateHarnessModelMessages(step.session.history);
  const size = sizeOf(step.session, getInputTokenCount(messages, compaction, envelope, envelope));
  const { projection } = step.view();
  const change = lazyChange(step, {
    changeId: nextChangeId(projection),
    prompt: messages,
    runId: nextRunId(projection),
    started: {
      kind: "compaction",
      trigger: { inputTokens: size.tokens },
      turnId: step.position().turnId,
    },
  });
  try {
    const resolvedModel = await resolveEffectiveRuntimeModel({
      config: step.config,
      ctx: step.ctx,
      session: step.session,
    });
    step.session = resolvedModel.session;
    await decideHistory(step, {
      change,
      messages,
      model: resolvedModel.model,
      phase: "turn-end",
      promptMessages: messages,
      reason: "automatic",
      requestEnvelopeTokens: envelope,
      size,
      telemetryTurnId: activeTurnId(step.position()),
    });
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    logError(log, "turn-end compaction failed", error, { sessionId: step.session.sessionId });
  }
}

/** The session model's context window and output limit. */
function modelLimitsOf(
  session: HarnessSession,
): Pick<CompactionMeasure, "contextWindowTokens" | "maxOutputTokens"> {
  const { compaction } = session;
  return {
    contextWindowTokens:
      compaction.thresholdPercent === undefined
        ? compaction.threshold
        : Math.round(compaction.threshold / compaction.thresholdPercent),
    maxOutputTokens: requireSessionModelReference(session).maxOutputTokens,
  };
}

function sizeOf(session: HarnessSession, tokens: number): HistorySize {
  const window = requireSessionModelReference(session).contextWindowTokens;
  return { tokens, ...(window !== undefined && { window }) };
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
    readonly started: Omit<Parameters<typeof contextStarted>[0], "changeId">;
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
      await step.publish(
        contextStarted({ changeId: input.changeId, ...input.started }),
        input.prompt,
      );
      // A memory capture before compaction ran in the commit that started it. When it failed, the
      // compaction fails before it rewrites the history the capture couldn't keep.
      const captureFailure = takeCompactionCaptureFailure(step.ctx);
      if (captureFailure !== undefined) throw captureFailure;
    },
  };
}

/**
 * The program's history for the next call, committed. Unchanged, nothing happens. Changed only
 * where the model hasn't read yet, it joins the history as new messages do. Changed where the
 * model has read, it's checked, then rewrites the history under a compaction change. eve's
 * summaries apply as they are. Under `eve dev` and in tests, the program must return the same
 * history when asked again about what it returned.
 */
async function decideHistory(
  step: Step,
  input: {
    /** Between turns, no turn's usage reports the summary calls. */
    readonly betweenTurns?: true;
    readonly change: LazyChange;
    readonly compact?: true;
    readonly messages: readonly HarnessModelMessage[];
    /** The turn's model, which writes summaries unless the agent names a compaction model. */
    readonly model: LanguageModel;
    /** Where eve asks: before a model call, after the turn's answer, or `session.compact()`. */
    readonly phase: CompactionPhase | "manual";
    readonly promptMessages: readonly HarnessModelMessage[];
    readonly reason: CompactionReason;
    /** What the turn's request starts with, when a model call is about to send it. */
    readonly request?: StrategyContext["request"];
    readonly requestEnvelopeTokens: number | undefined;
    readonly size: HistorySize;
    readonly telemetryTurnId?: string;
  },
): Promise<HarnessModelMessage[] | undefined> {
  const { change } = input;
  const summaryUsage: (TokenUsageDelta | undefined)[] = [];
  const summaries = new WeakSet<object>();
  const executors = new Map<
    PublicAgentStaticModelDefinition | undefined,
    ReturnType<typeof summaryExecutor>
  >();
  let runOpen = false;
  const summarizeWith =
    (model?: PublicAgentStaticModelDefinition): SummaryCall =>
    async (prompt) => {
      await change.open();
      const known = executors.get(model) ?? summaryExecutor(step, input, model);
      executors.set(model, known);
      const executor = await known;
      if (!runOpen) {
        runOpen = true;
        await step.publish([
          runRequested({ changeId: change.changeId }, change.runId),
          runStarted({ attempt: 0, modelId: executor.modelId, runId: change.runId }),
        ]);
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
  const summarize: Summarize = async (history, options) => {
    await change.open();
    const rewrite = historyContext(step.session, {
      ...input,
      threshold: options?.tokens ?? step.session.compaction.threshold,
    });
    const summarized = (await compactMessages(
      validateHarnessModelMessages([...history]),
      rewrite.config,
      withInstructions(summarizeWith(options?.model), options?.instructions),
      input.compact === true,
      rewrite.historyTokens,
    )) as HarnessModelMessage[];
    summaries.add(summarized);
    return summarized;
  };
  const strategy = step.config.compactionStrategy;
  const threshold = nativeThreshold(input.size, step.session.compaction);
  const strategyAt = (
    reason: CompactionReason,
    at: {
      readonly open: () => Promise<void>;
      readonly phase: CompactionPhase | "manual";
      readonly summarizeWith: typeof summarizeWith;
    },
  ) =>
    strategy === undefined
      ? undefined
      : strategyHistory(strategy, {
          abortSignal: step.config.abortSignal ?? new AbortController().signal,
          changeId: change.changeId,
          limit: fitLimit(input),
          model: modelLimitsOf(step.session),
          open: at.open,
          phase: at.phase,
          reason,
          request: input.request ?? { instructions: step.session.agent.system ?? undefined },
          sessionId: step.session.sessionId,
          summarizeWith: at.summarizeWith,
          threshold,
        });
  const history = strategyAt(input.reason, {
    open: () => change.open(),
    phase: input.phase,
    summarizeWith,
  });
  // Asked again before the next call, a strategy keeps what it returned.
  const again = strategyAt("automatic", {
    open: async () => {},
    phase: "step",
    summarizeWith: () => () => {
      throw new Error("The compaction strategy summarizes what it already returned.");
    },
  });

  const before = validateHarnessModelMessages(input.messages);
  let messages: HarnessModelMessage[] | undefined;
  try {
    const kept = await programHistory(step, {
      compact: input.compact,
      ...(history !== undefined && { history }),
      messages: before,
      size: input.size,
      summarize,
    });
    if (kept === before || isDeepStrictEqual(kept, before)) {
      if (change.opened) await settleChange(step, { ...input, runOpen, summaryUsage }, before);
      return undefined;
    }
    const read = readCount(step.session, before);
    if (!change.opened && isDeepStrictEqual(kept.slice(0, read), before.slice(0, read))) {
      messages = validateHarnessModelMessages(kept);
      await assertFixpoint(step, messages, { ...input, history: again });
      step.session = changeHistory(step.session, { unread: messages });
      return messages;
    }
    await change.open();
    messages = summaries.has(kept)
      ? (kept as HarnessModelMessage[])
      : checkHistory(before, kept, {
          limit: fitLimit(input),
          ...(history !== undefined && { subject: "The compaction strategy's history" }),
        });
    await assertFixpoint(step, messages, { ...input, history: again });
  } catch (error) {
    const usage = summaryUsageOf(summaryUsage);
    countSummaryUsage(step, input.betweenTurns, usage);
    if (change.opened) {
      await step.publish(
        summaryFailed(step.view().projection.view, {
          changeId: change.changeId,
          error,
          ...(usage !== undefined && { spent: { runId: change.runId, usage } }),
        }),
      );
    }
    throw error;
  }
  await settleChange(step, { ...input, runOpen, summaryUsage }, messages);
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
    [
      // Every summary call that returned left an entry, even without usage.
      ...(input.summaryUsage.length > 0
        ? runSettledFacts({
            finishReason: "stop",
            outcome: "completed",
            runId: change.runId,
            usage,
          })
        : input.runOpen
          ? runSettledFacts({ outcome: "abandoned", runId: change.runId })
          : []),
      {
        data: { changeId: change.changeId, kind: "compaction", outcome: "completed" },
        type: "context.settled",
      },
    ],
    messages,
  );
}

/**
 * How many of the history's messages the model has read: what its last measured call sent. Without
 * a measurement, every message counts as read, so a change to it is a rewrite.
 */
function readCount(session: HarnessSession, history: readonly HarnessModelMessage[]): number {
  const count = session.compaction.lastKnownPromptMessageCount;
  return count === undefined ? history.length : Math.min(count, history.length);
}

/** The history's room in the model's window, beside the rest of the call. Unknown, unbounded. */
function fitLimit(input: {
  readonly messages: readonly HarnessModelMessage[];
  readonly promptMessages: readonly HarnessModelMessage[];
  readonly requestEnvelopeTokens: number | undefined;
  readonly size: HistorySize;
}): number {
  if (input.size.window === undefined) return Number.POSITIVE_INFINITY;
  const around = Math.max(0, estimateTokens(input.promptMessages) - estimateTokens(input.messages));
  return Math.max(1, input.size.window - (input.requestEnvelopeTokens ?? 0) - around);
}

/**
 * Under `eve dev` and in tests, a program asked about the history it returned returns it again:
 * one that keeps rewriting the past would rewrite it on every call.
 */
async function assertFixpoint(
  step: Step,
  history: HarnessModelMessage[],
  input: {
    readonly history?: (ctx: ProgramContext) => Promise<readonly HarnessModelMessage[] | undefined>;
    readonly requestEnvelopeTokens: number | undefined;
    readonly size: HistorySize;
  },
): Promise<void> {
  if (!checksHistory()) return;
  const again = await programHistory(step, {
    ...(input.history !== undefined && { history: input.history }),
    messages: history,
    size: {
      ...input.size,
      tokens: estimateTokens(history) + (input.requestEnvelopeTokens ?? 0),
    },
    summarize: () => {
      throw new Error("The session program's history summarizes what it already returned.");
    },
  });
  if (again !== history && !isDeepStrictEqual(again, history)) {
    throw new Error(
      "The session program's history changes what it returned when asked again. Return the history as it is when nothing needs to change.",
    );
  }
}

/**
 * The history's share of the threshold and of the last measurement. Whatever the model sees
 * besides the history (instructions, tools, memory, client context) is kept whole, so it takes
 * room like the envelope.
 */
function historyContext(
  session: HarnessSession,
  input: {
    readonly messages: readonly HarnessModelMessage[];
    readonly promptMessages: readonly HarnessModelMessage[];
    readonly requestEnvelopeTokens: number | undefined;
    /** The call's input tokens to aim under. */
    readonly threshold: number;
  },
): { readonly config: CompactionConfig; readonly historyTokens?: number } {
  const { compaction } = session;
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

/** Appends a strategy's instructions to eve's summary prompt. */
function withInstructions(
  summarize: SummaryCall,
  instructions: string | undefined,
): CompactionSummarizer {
  if (instructions === undefined) return summarize;
  return (prompt) => summarize({ ...prompt, system: `${prompt.system}\n\n${instructions}` });
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

type CompactionSummaryPrompt = Parameters<SummaryCall>[0];

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
  const result = streamText({
    ...input,
    ...(input.tools !== undefined && { toolChoice: "none" as const }),
    onError: () => {},
  });
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
