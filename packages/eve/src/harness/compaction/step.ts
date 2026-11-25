import { type LanguageModel, type ModelMessage, streamText } from "ai";

import { CompactionOverLimitError } from "#harness/compaction/over-limit-error.js";
import { estimateTokens } from "#harness/token-estimate.js";
import { createLogger, logError } from "#internal/logging.js";
import { AuthKey } from "#context/keys.js";
import { changeHistory } from "#harness/session-machine/history.js";
import { type CompactionConfig, type CompactionStage, type StepResult } from "#harness/types.js";
import {
  type HarnessModelMessage,
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
  type HistoryCompactionConfig,
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
    await summarizeHistory(step, {
      compaction,
      betweenTurns: true,
      change,
      compact: true,
      messages,
      turnModel: () => credentialedModel(resolvedModel.model),
      promptMessages: messages,
      requestEnvelopeTokens: compaction.requestEnvelopeTokens,
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
    compaction: config,
    messages: input.messages,
    turnModel: async () => ({ model: input.model, renew: input.renew }),
    promptMessages: prompt,
    requestEnvelopeTokens: input.requestEnvelopeTokens,
    telemetryTurnId: activeTurnId(step.position()),
  });
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

async function summarizeHistory(
  step: Step,
  input: {
    readonly betweenTurns?: true;
    readonly change: LazyChange;
    readonly compact?: true;
    readonly compaction: CompactionConfig;
    readonly messages: readonly HarnessModelMessage[];
    readonly turnModel: () => Promise<CredentialedModel>;
    readonly promptMessages: readonly HarnessModelMessage[];
    readonly requestEnvelopeTokens: number | undefined;
    readonly telemetryTurnId?: string;
  },
): Promise<HarnessModelMessage[] | undefined> {
  const { change } = input;
  const before = validateHarnessModelMessages(input.messages);
  const { compaction } = input;
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
  let stage: CompactionStage;
  try {
    const compacted = await compactMessages(
      before,
      historyConfig(compaction, input),
      summarize,
      input.compact === true,
      input.betweenTurns !== true,
    );
    messages = compacted.messages as HarnessModelMessage[];
    stage = compacted.stage;
    if (!isDeepStrictEqual(messages, before)) await change.open();
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
  const unchanged = isDeepStrictEqual(messages, before);
  if (change.opened) {
    await settleChange(step, { ...input, runOpen, summaryUsage }, unchanged ? before : messages);
  }
  if (unchanged) return undefined;
  const rewritten = changeHistory(step.session, { rewrite: messages });
  step.session = { ...rewritten, compaction: { ...rewritten.compaction, lastStage: stage } };
  return messages;
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
): HistoryCompactionConfig {
  const requestEnvelopeTokens = input.requestEnvelopeTokens ?? 0;
  const protectedTokens = Math.max(
    0,
    estimateTokens(input.promptMessages) - estimateTokens(input.messages),
  );
  const { threshold } = compaction;
  assertFixedPartFits({ protectedTokens, requestEnvelopeTokens, threshold });
  const fixedPromptTokens = requestEnvelopeTokens + protectedTokens;
  return {
    ...compaction,
    fixedPromptTokens,
    target: Math.max(
      1,
      Math.floor(compaction.target - fixedPromptTokens * estimateRatio(compaction)),
    ),
    threshold: Math.max(1, threshold - fixedPromptTokens),
  };
}

async function compactionModel(
  step: Step,
  reference: RuntimeModelReference,
): Promise<CredentialedModel> {
  const resolved = await step.config.resolveModel(reference);
  return await credentialedModel(resolved);
}

async function summaryExecutor(
  step: Step,
  input: {
    readonly change: { readonly runId: string };
    readonly turnModel: () => Promise<CredentialedModel>;
    readonly telemetryTurnId?: string;
  },
): Promise<{
  readonly modelId: string;
  summarize(prompt: CompactionSummaryPrompt): ReturnType<typeof streamCompactionSummary>;
}> {
  const { config, session } = step;
  const turnReference = stepReference(step);
  const reference = agentSettings(step).compactionModel ?? turnReference;
  const { model, renew } =
    reference === turnReference ? await input.turnModel() : await compactionModel(step, reference);
  const profile = resolveModelProfile(model);
  const attempt = step.instrumentation?.prepareAttempt({
    attempt: 0,
    runId: input.change.runId,
    runtimeContext: { "eve.compaction.request": "summary" },
    ...(input.telemetryTurnId !== undefined && { turnId: input.telemetryTurnId }),
  });
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
    onLanguageModelCallEnd: attempt?.onLanguageModelCallEnd,
    telemetry: attempt?.telemetry,
  };
  const retryScope = { sessionId: session.sessionId, turnId: step.position().turnId };
  const summarize = (prompt: CompactionSummaryPrompt) =>
    runModelCallWithRetries(
      () => streamCompactionSummary({ ...call, ...prompt }),
      retryScope,
      config.abortSignal,
    );
  return {
    modelId: gatewayModelId(model) ?? "unknown",
    async summarize(prompt) {
      for (;;) {
        try {
          return await summarize(prompt);
        } catch (error) {
          if (renew === undefined || !rejectsCredential(error)) throw error;
          await renew(error);
        }
      }
    },
  };
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

type CompactionSummaryPrompt = Parameters<CompactionSummarizer>[0];

async function streamCompactionSummary(
  input: CompactionSummaryPrompt &
    Pick<
      Parameters<typeof streamText>[0],
      | "abortSignal"
      | "headers"
      | "model"
      | "onLanguageModelCallEnd"
      | "providerOptions"
      | "telemetry"
    >,
): Promise<{
  readonly finishReason: string;
  readonly text: string;
  readonly usage: TokenUsageDelta | undefined;
}> {
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
