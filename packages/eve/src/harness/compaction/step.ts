import { type LanguageModel, type ModelMessage, streamText, type ToolSet } from "ai";

import {
  CompactionOverLimitError,
  CompactionResultOverLimitError,
} from "#harness/compaction/over-limit-error.js";
import { estimateTokens } from "#harness/token-estimate.js";
import { createLogger, logError } from "#internal/logging.js";
import { AuthKey } from "#context/keys.js";
import { changeHistory } from "#harness/session-machine/history.js";
import {
  type RequestInstructions,
  type RequestPrefix,
  resolveStrategy,
  strategyHistory,
  type StrategyContext,
  type StrategyInput,
  type Summarize,
  type SummaryCall,
  triggersAt,
} from "#harness/compaction/authored.js";
import { checkHistory } from "#harness/compaction/check.js";
import { requestPrefix } from "#harness/compaction/request-prefix.js";
import type { CompactionContext, CompactionReason } from "#shared/compaction-strategy.js";
import type { PublicAgentStaticModelDefinition } from "#shared/agent-definition.js";
import { checksSessionEvents } from "#shared/dev-checks.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { hydrateSandboxAttachments } from "#harness/attachment-staging.js";
import { type CompactionConfig, type CompactionStage, type StepResult } from "#harness/types.js";
import {
  type HarnessModelMessage,
  isInjectedMessage,
  isUserModelMessage,
  validateHarnessModelMessages,
} from "#harness/messages.js";
import { type Step, stepReference } from "#harness/step/context.js";
import { agentSettings } from "#execution/effective-agent-config.js";
import { againstWindow, compactionConfig } from "#harness/compaction/config.js";
import { activeTurnId } from "#harness/session-machine/view.js";
import {
  buildGatewayAttributionHeaders,
  resolveEffectiveRuntimeModel,
  withGatewayTraceContext,
} from "#harness/model-call/model.js";
import { type CredentialedModel, credentialedModel } from "#harness/model-call/credential.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import {
  compactMessages,
  type CompactionSummarizer,
  estimateRatio,
  getInputTokenCount,
  shouldCompact,
} from "#harness/compaction/engine.js";
import { takeBlockingFailure } from "#definitions/kernel.js";
import { isDeepStrictEqual } from "node:util";
import type { Usage } from "#protocol/session-events/envelope.js";
import { nextChangeId, nextRunId } from "#protocol/session-projection.js";
import { normalizeModelStreamError, rejectsCredential } from "#harness/model-call/errors.js";
import { runModelCallWithRetries } from "#harness/model-call/retry.js";
import {
  extractGatewayCostUsd,
  extractTokenUsageDelta,
  gatewayModelId,
  type TokenUsageDelta,
} from "#harness/model-call/usage.js";
import { modelIdentity, resolveModelProfile } from "#harness/model-profile.js";
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
import { throwIfSessionStreamDead } from "#harness/session-stream-write-error.js";

const log = createLogger("harness.tool-loop");
export function assertFixedPartFits(input: {
  readonly protectedTokens: number;
  readonly requestEnvelopeTokens: number;
  readonly threshold: number;
}): void {
  const fixed = input.requestEnvelopeTokens + input.protectedTokens;
  if (fixed >= input.threshold) {
    throw new CompactionOverLimitError(
      `The agent's system prompt, tools, memory and context take ~${Math.round(fixed)} tokens, over this model's ~${input.threshold}-token compaction limit. Shorten the instructions, remove tools or trim memory, or raise \`compaction.threshold\`.`,
    );
  }
}

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
    const resolvedModel = await resolveEffectiveRuntimeModel(step, {
      abortSignal: config.abortSignal,
      conversation: messages,
    });
    step.model = resolvedModel.choice;
    const compaction = compactionConfig(step);
    await decideHistory(step, {
      compaction,
      betweenTurns: true,
      change,
      compact: true,
      event: undefined,
      messages,
      turnModel: () => credentialedModel(resolvedModel.model),
      promptMessages: messages,
      reason: "manual",
      requestEnvelopeTokens: compaction.requestEnvelopeTokens,
      size: getInputTokenCount(
        messages,
        compaction,
        compaction.requestEnvelopeTokens,
        compaction.requestEnvelopeTokens,
      ),
    });
  } catch (error) {
    outcome = "failed";
    logError(log, "manual session compaction failed", error, {
      sessionId: step.session.sessionId,
    });
  }
  const reason = outcome === "failed" ? "compaction-failed" : undefined;
  await step.apply(settleDelivery(deliveryId, outcome, reason));
  return { next: null, session: step.session };
}

interface HistoryBeforeCallInput {
  readonly messages: readonly HarnessModelMessage[];
  readonly promptMessages: readonly HarnessModelMessage[];
  readonly model: LanguageModel;
  readonly renew?: (rejection: unknown) => Promise<void>;
  readonly requestEnvelopeTokens: number;
  readonly request: RequestPrefix;
  readonly event: "model.requested" | "model.retried";
  readonly overflow?: true;
}

export async function historyBeforeCall(
  step: Step,
  input: HistoryBeforeCallInput,
): Promise<HarnessModelMessage[] | undefined> {
  const prompt = validateHarnessModelMessages(input.promptMessages);
  const config = compactionConfig(step, {
    messages: prompt,
    requestEnvelopeTokens: input.requestEnvelopeTokens,
  });
  try {
    return await compactUnder(step, input, prompt, config);
  } catch (error) {
    if (!(error instanceof CompactionOverLimitError)) throw error;
    if (error instanceof CompactionResultOverLimitError) throw error;
    const window = config.contextWindowTokens;
    const scope = { sessionId: step.session.sessionId, turnId: step.position().turnId };
    if (window === undefined) {
      log.warn(
        `${error.message} eve doesn't know this model's context window, so it sends the request as it is. Set \`modelContextWindowTokens\` in \`agent.ts\` to compact against it.`,
        scope,
      );
      return undefined;
    }
    if (window > config.threshold) {
      log.warn(
        `${error.message} eve compacts against the model's ~${window}-token context window instead.`,
        scope,
      );
      try {
        return await compactUnder(step, input, prompt, againstWindow(config, window));
      } catch (overWindow) {
        if (!(overWindow instanceof CompactionOverLimitError)) throw overWindow;
      }
    }
    throw new CompactionOverLimitError(
      `The agent's system prompt, tools, memory and context leave no room for the conversation in this model's ~${window}-token context window. Shorten the instructions, remove tools or trim memory.`,
    );
  }
}

async function compactUnder(
  step: Step,
  input: HistoryBeforeCallInput,
  prompt: HarnessModelMessage[],
  config: CompactionConfig,
): Promise<HarnessModelMessage[] | undefined> {
  const previousEnvelope = config.requestEnvelopeTokens;
  const overflow = input.overflow === true;
  const strategy = resolveStrategy(agentSettings(step).compactionStrategy);
  if (
    strategy === undefined
      ? !overflow && !shouldCompact(prompt, config, input.requestEnvelopeTokens, previousEnvelope)
      : !overflow && !triggersAt(strategy, input.event)
  ) {
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
  return await decideHistory(step, {
    change,
    compaction: config,
    ...(overflow && { compact: true as const }),
    event: input.event,
    messages: input.messages,
    turnModel: async () => ({ model: input.model, renew: input.renew }),
    promptMessages: prompt,
    reason: overflow ? "overflow" : "automatic",
    request: input.request,
    requestEnvelopeTokens: input.requestEnvelopeTokens,
    size: tokens,
    telemetryTurnId: activeTurnId(step.position()),
  });
}

export async function compactAtTurnEnd(step: Step): Promise<void> {
  if (!triggersAt(resolveStrategy(agentSettings(step).compactionStrategy), "turn.settled")) return;
  if (step.session.history.length === 0) return;
  const messages = validateHarnessModelMessages(step.session.history);
  try {
    const resolvedModel = await resolveEffectiveRuntimeModel(step, {
      abortSignal: step.config.abortSignal,
      conversation: messages,
    });
    step.model ??= resolvedModel.choice;
    const compaction = compactionConfig(step);
    const envelope = compaction.requestEnvelopeTokens ?? 0;
    const size = getInputTokenCount(messages, compaction, envelope, envelope);
    const { projection } = step.view();
    const change = lazyChange(step, {
      changeId: nextChangeId(projection),
      prompt: messages,
      runId: nextRunId(projection),
      started: {
        kind: "compaction",
        trigger: { inputTokens: size },
        turnId: step.position().turnId,
      },
    });
    await decideHistory(step, {
      change,
      compaction,
      event: "turn.settled",
      messages,
      turnModel: () => credentialedModel(resolvedModel.model),
      promptMessages: messages,
      reason: "automatic",
      requestEnvelopeTokens: envelope,
      size,
      telemetryTurnId: activeTurnId(step.position()),
    });
  } catch (error) {
    throwIfSessionStreamDead(error);
    throwIfTurnAborted(step.config.abortSignal);
    logError(log, "turn-end compaction failed", error, { sessionId: step.session.sessionId });
  }
}

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
      const captureFailure = takeBlockingFailure(step.ctx);
      if (captureFailure !== undefined) throw captureFailure;
    },
  };
}

async function decideHistory(
  step: Step,
  input: {
    readonly betweenTurns?: true;
    readonly change: LazyChange;
    readonly compact?: true;
    readonly compaction: CompactionConfig;
    readonly event: CompactionContext["event"];
    readonly messages: readonly HarnessModelMessage[];
    readonly turnModel: () => Promise<CredentialedModel>;
    readonly promptMessages: readonly HarnessModelMessage[];
    readonly reason: CompactionReason;
    readonly request?: RequestPrefix;
    readonly requestEnvelopeTokens: number | undefined;
    readonly size: number;
    readonly telemetryTurnId?: string;
  },
): Promise<HarnessModelMessage[] | undefined> {
  const { change, compaction } = input;
  const before = validateHarnessModelMessages(input.messages);
  const summaryUsage: (TokenUsageDelta | undefined)[] = [];
  const summaries = new WeakSet<object>();
  let stage: CompactionStage | undefined;
  let runOpen = false;
  const turnModel = once(input.turnModel);
  const requestOf = once(
    async (): Promise<RequestPrefix> =>
      input.request ?? (await requestPrefix(step, (await turnModel()).model)),
  );
  const executors = new Map<
    PublicAgentStaticModelDefinition | "turn" | undefined,
    Promise<Awaited<ReturnType<typeof summaryExecutor>>>
  >();
  const executorFor = (which: PublicAgentStaticModelDefinition | "turn" | undefined) => {
    const known = executors.get(which) ?? summaryExecutor(step, { ...input, turnModel }, which);
    executors.set(which, known);
    return known;
  };
  const openRun = async (modelId: string) => {
    if (runOpen) return;
    runOpen = true;
    await step.publish(
      startSummaryRun({ changeId: change.changeId, modelId, runId: change.runId }),
    );
  };
  const summarizeWith =
    (model?: PublicAgentStaticModelDefinition): SummaryCall =>
    async (prompt) => {
      await change.open();
      const executor = await executorFor(model);
      await openRun(executor.modelId);
      const summary = await executor.summarize({
        ...prompt,
        messages: await hydrateSandboxAttachments(prompt.messages),
      });
      summaryUsage.push(summary.usage);
      if (summary.text.trim().length === 0) {
        throw new Error(
          `The compaction model returned an empty summary. Finish reason: ${summary.finishReason}.`,
        );
      }
      return summary.text;
    };
  const summarize: Summarize = async (history, options) => {
    const compacted = await compactMessages(
      validateHarnessModelMessages([...history]),
      historyConfig(compaction, input),
      withInstructions(summarizeWith(options.model), options.instructions),
      input.compact === true,
      input.betweenTurns !== true,
    );
    const summarized = compacted.messages as HarnessModelMessage[];
    stage = compacted.stage;
    summaries.add(summarized);
    return summarized;
  };
  const send: StrategyContext["send"] = async (history, providerOptions) => {
    await change.open();
    const executor = await executorFor("turn");
    await openRun(executor.modelId);
    const request = await requestOf();
    const sent = await executor.send({
      messages: await hydrateSandboxAttachments(history.filter((m) => !isInjectedMessage(m))),
      system: request.instructions,
      tools: request.tools,
      providerOptions,
    });
    summaryUsage.push(sent.usage);
    return validateHarnessModelMessages(sent.messages);
  };
  const strategy = resolveStrategy(agentSettings(step).compactionStrategy);
  const strategyAt = (
    reason: CompactionReason,
    event: CompactionContext["event"],
    at: Pick<StrategyContext, "open" | "send" | "summarizeWith">,
  ) =>
    strategy === undefined
      ? undefined
      : strategyHistory(strategy, {
          abortSignal: step.config.abortSignal ?? new AbortController().signal,
          changeId: change.changeId,
          event,
          identity: async () => modelIdentity((await turnModel()).model),
          limit: fitLimit(input),
          model: {
            ...(compaction.contextWindowTokens !== undefined && {
              contextWindowTokens: compaction.contextWindowTokens,
            }),
            ...(stepReference(step).maxOutputTokens !== undefined && {
              maxOutputTokens: stepReference(step).maxOutputTokens,
            }),
          },
          reason,
          request: requestOf,
          sessionId: step.session.sessionId,
          threshold: compaction.threshold,
          ...at,
        });
  const history = strategyAt(input.reason, input.event, {
    open: () => change.open(),
    send,
    summarizeWith,
  });
  const refuse = (): never => {
    throw new Error("The compaction strategy compacts what it already returned.");
  };
  const again = strategyAt("automatic", "model.requested", {
    open: async () => {},
    send: refuse,
    summarizeWith: () => refuse,
  });

  let messages: HarnessModelMessage[];
  try {
    const kept =
      history === undefined
        ? await summarize(before, {})
        : await history({ history: before, inputTokens: input.size, summarize });
    if (kept === undefined || isDeepStrictEqual(kept, before)) {
      if (change.opened) await settleChange(step, { ...input, runOpen, summaryUsage }, before);
      return undefined;
    }
    await change.open();
    messages = summaries.has(kept)
      ? (kept as HarnessModelMessage[])
      : checkHistory(before, kept, { limit: fitLimit(input) });
    if (again !== undefined) await assertFixpoint(messages, again, input);
  } catch (error) {
    throwIfSessionStreamDead(error);
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
  await settleChange(step, { ...input, runOpen, summaryUsage }, messages);
  const rewritten = changeHistory(step.session, { rewrite: messages });
  step.session =
    stage === undefined
      ? rewritten
      : { ...rewritten, compaction: { ...rewritten.compaction, lastStage: stage } };
  return messages;
}

function once<T>(produce: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= produce());
}

function withInstructions(
  summarize: SummaryCall,
  instructions: string | undefined,
): CompactionSummarizer {
  if (instructions === undefined) return summarize as CompactionSummarizer;
  return (prompt) => summarize({ ...prompt, system: `${prompt.system}\n\n${instructions}` });
}

function fitLimit(input: {
  readonly compaction: CompactionConfig;
  readonly messages: readonly HarnessModelMessage[];
  readonly promptMessages: readonly HarnessModelMessage[];
  readonly requestEnvelopeTokens: number | undefined;
}): number {
  const window = input.compaction.contextWindowTokens;
  if (window === undefined) return Number.POSITIVE_INFINITY;
  const around = Math.max(0, estimateTokens(input.promptMessages) - estimateTokens(input.messages));
  return Math.max(1, window - (input.requestEnvelopeTokens ?? 0) - around);
}

async function assertFixpoint(
  history: HarnessModelMessage[],
  again: (input: StrategyInput) => Promise<readonly HarnessModelMessage[] | undefined>,
  input: { readonly requestEnvelopeTokens: number | undefined },
): Promise<void> {
  if (!checksSessionEvents()) return;
  const kept = await again({
    history,
    inputTokens: estimateTokens(history) + (input.requestEnvelopeTokens ?? 0),
    summarize: () => {
      throw new Error("The compaction strategy compacts what it already returned.");
    },
  });
  if (kept !== undefined && !isDeepStrictEqual(kept, history)) {
    throw new Error(
      "The compaction strategy changes what it returned when asked again. Return the history as it is when nothing needs to change.",
    );
  }
}

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
      summarized: input.summaryUsage.length > 0,
      usage,
    }),
    messages,
  );
}

function historyConfig(
  compaction: CompactionConfig,
  input: {
    readonly messages: readonly HarnessModelMessage[];
    readonly promptMessages: readonly HarnessModelMessage[];
    readonly requestEnvelopeTokens: number | undefined;
  },
): CompactionConfig {
  const requestEnvelopeTokens = input.requestEnvelopeTokens ?? 0;
  const protectedTokens = Math.max(
    0,
    estimateTokens(input.promptMessages) - estimateTokens(input.messages),
  );
  const { threshold } = compaction;
  assertFixedPartFits({ protectedTokens, requestEnvelopeTokens, threshold });
  const fixedTokens = requestEnvelopeTokens + protectedTokens;
  return {
    ...compaction,
    target: Math.max(1, Math.floor(compaction.target - fixedTokens * estimateRatio(compaction))),
    threshold: Math.max(1, threshold - fixedTokens),
  };
}

async function compactionModel(
  step: Step,
  reference: RuntimeModelReference,
): Promise<CredentialedModel> {
  const resolved = await step.config.resolveModel(reference);
  return await credentialedModel(resolved);
}

interface CompactionRequest {
  readonly messages: ModelMessage[];
  readonly system: RequestInstructions;
  readonly tools?: ToolSet;
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

async function summaryExecutor(
  step: Step,
  input: {
    readonly change: { readonly runId: string };
    readonly turnModel: () => Promise<CredentialedModel>;
    readonly telemetryTurnId?: string;
  },
  which: PublicAgentStaticModelDefinition | "turn" | undefined,
): Promise<{
  readonly modelId: string;
  summarize(prompt: CompactionRequest): ReturnType<typeof streamCompactionSummary>;
  send(prompt: CompactionRequest): ReturnType<typeof streamCompactionSummary>;
}> {
  const { config, session } = step;
  const turnReference = stepReference(step);
  const named = which === undefined || which === "turn" ? undefined : which;
  const reference: RuntimeModelReference | undefined =
    typeof named === "string"
      ? { id: named }
      : named !== undefined
        ? undefined
        : which === "turn"
          ? turnReference
          : (agentSettings(step).compactionModel ?? turnReference);
  const { model, renew } =
    named !== undefined && typeof named !== "string"
      ? { model: named as LanguageModel, renew: undefined }
      : reference === turnReference
        ? await input.turnModel()
        : await compactionModel(step, reference!);
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
      providerOptions: reference?.providerOptions,
      session,
    }) as Parameters<typeof streamText>[0]["providerOptions"],
    telemetry: step.instrumentation?.prepareAttempt({
      attempt: 0,
      runId: input.change.runId,
      runtimeContext: { "eve.compaction.request": which === "turn" ? "turn" : "summary" },
      ...(input.telemetryTurnId !== undefined && { turnId: input.telemetryTurnId }),
    }).telemetry,
  };
  const retryScope = { sessionId: session.sessionId, turnId: step.position().turnId };
  const run = async (prompt: CompactionRequest) => {
    const { providerOptions, tools, ...rest } = prompt;
    for (;;) {
      try {
        return await runModelCallWithRetries(
          () =>
            streamCompactionSummary({
              ...call,
              ...rest,
              providerOptions: mergeProviderOptions(call.providerOptions, providerOptions),
              ...(tools !== undefined && { tools: withoutExecutors(tools) }),
            }),
          retryScope,
          config.abortSignal,
        );
      } catch (error) {
        if (renew === undefined || !rejectsCredential(error)) throw error;
        await renew(error);
      }
    }
  };
  return { modelId: gatewayModelId(model) ?? "unknown", summarize: run, send: run };
}

function mergeProviderOptions(
  base: Parameters<typeof streamText>[0]["providerOptions"],
  extra: CompactionRequest["providerOptions"],
): Parameters<typeof streamText>[0]["providerOptions"] {
  if (extra === undefined) return base;
  const merged: Record<string, Record<string, unknown>> = { ...base };
  for (const [provider, options] of Object.entries(extra)) {
    merged[provider] = { ...merged[provider], ...options };
  }
  return merged as Parameters<typeof streamText>[0]["providerOptions"];
}

function withoutExecutors(tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [name, { ...tool, execute: undefined }]),
  ) as ToolSet;
}

function countSummaryUsage(step: Step, betweenTurns: true | undefined, usage: Usage | undefined) {
  if (usage !== undefined && betweenTurns === true) {
    step.session = markUsageReported(step.session, usage);
  }
}

function summaryUsageOf(deltas: readonly (TokenUsageDelta | undefined)[]): Usage | undefined {
  const spent = deltas.filter((delta) => delta !== undefined);
  if (spent.length === 0) return undefined;
  return spent.reduce<Usage>((total, delta) => addTokenUsage(total, usageOf(delta)), NO_USAGE);
}

export function compactedTurnInput<Message extends ModelMessage>(
  messages: readonly Message[],
): Message | undefined {
  return messages.findLast((message) => isUserModelMessage(message) && message.kind === "user");
}

async function streamCompactionSummary(
  input: Omit<CompactionRequest, "providerOptions" | "tools"> &
    Pick<
      Parameters<typeof streamText>[0],
      "abortSignal" | "headers" | "model" | "providerOptions" | "telemetry" | "tools"
    >,
): Promise<{
  readonly finishReason: string;
  readonly messages: ModelMessage[];
  readonly text: string;
  readonly usage: TokenUsageDelta | undefined;
}> {
  const result = streamText({ ...input, onError: () => {} });
  for await (const part of result.fullStream) {
    if (part.type === "error") throw normalizeModelStreamError(part.error);
  }
  const [text, finishReason, usage, providerMetadata, response] = await Promise.all([
    result.text,
    result.finishReason,
    result.usage,
    result.providerMetadata,
    result.response,
  ]);
  return {
    finishReason,
    messages: response.messages,
    text,
    usage: extractTokenUsageDelta({ costUsd: extractGatewayCostUsd(providerMetadata), usage }),
  };
}
