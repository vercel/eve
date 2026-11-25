import { type LanguageModel, type ModelMessage, streamText, type ToolSet } from "ai";

import { estimateTokens } from "#harness/token-estimate.js";
import { createLogger, logError } from "#internal/logging.js";
import { AuthKey } from "#context/keys.js";
import { changeHistory } from "#harness/session-machine/history.js";
import {
  type RequestInstructions,
  type RequestPrefix,
  strategyHistory,
} from "#harness/compaction/strategy.js";
import { checkHistory } from "#harness/compaction/check.js";
import { requestPrefix } from "#harness/compaction/request-prefix.js";
import {
  type CompactionCallRequest,
  type CompactionCallResult,
  CompactionOverflowError,
  type CompactionStrategy,
} from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";
import { defaultCompaction } from "#public/experimental/compaction/default.js";
import type { PublicAgentStaticModelDefinition } from "#shared/agent-definition.js";
import { checksSessionEvents } from "#shared/dev-checks.js";
import { CompactionOverLimitError } from "#shared/compaction-over-limit-error.js";
import { hydrateSandboxAttachments } from "#harness/attachment-staging.js";
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
import { type CredentialedModel, credentialedModel } from "#harness/model-call/credential.js";
import { isDefinedModel } from "#models/definition.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { estimateRatio, getInputTokenCount } from "#harness/compaction/engine.js";
import { takeBlockingFailure } from "#definitions/kernel.js";
import { isDeepStrictEqual } from "node:util";
import type { Usage } from "#protocol/session-events/envelope.js";
import { nextChangeId, nextRunId } from "#protocol/session-projection.js";
import {
  isContextOverflowError,
  normalizeModelStreamError,
  rejectsCredential,
} from "#harness/model-call/errors.js";
import { runModelCallWithRetries } from "#harness/model-call/retry.js";
import {
  extractGatewayCostUsd,
  extractTokenUsageDelta,
  gatewayModelId,
  type TokenUsageDelta,
} from "#harness/model-call/usage.js";
import { modelIdentity, resolveModelProfile } from "#harness/model-profile.js";
import { readsOpenAICompaction, withoutOpenAICompaction } from "#shared/openai-compaction-item.js";
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
    const defined = isDefinedModel(resolvedModel.model) ? resolvedModel.model : undefined;
    await decideHistory(step, {
      compaction,
      betweenTurns: true,
      change,
      messages,
      turnModel: () => credentialedModel(resolvedModel.model),
      ...(defined !== undefined &&
        agentSettings(step).compactionModel !== undefined && {
          identity: async () => ({ provider: "defined", modelId: defined.id }),
        }),
      promptMessages: messages,
      requested: true,
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
  return await compactUnder(step, input, prompt, config);
}

function strategyOf(step: Step): CompactionStrategy {
  const settings = agentSettings(step);
  return settings.compactionStrategy ?? defaultCompaction({ threshold: settings.thresholdPercent });
}

async function compactUnder(
  step: Step,
  input: HistoryBeforeCallInput,
  prompt: HarnessModelMessage[],
  config: CompactionConfig,
): Promise<HarnessModelMessage[] | undefined> {
  const previousEnvelope = config.requestEnvelopeTokens;
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
    messages: input.messages,
    overflow: input.overflow === true,
    turnModel: async () => ({ model: input.model, renew: input.renew }),
    promptMessages: prompt,
    request: input.request,
    requestEnvelopeTokens: input.requestEnvelopeTokens,
    size: tokens,
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

async function decideHistory(
  step: Step,
  input: {
    readonly betweenTurns?: true;
    readonly change: LazyChange;
    readonly compaction: CompactionConfig;
    readonly messages: readonly HarnessModelMessage[];
    readonly overflow?: boolean;
    readonly turnModel: () => Promise<CredentialedModel>;
    readonly identity?: () => Promise<{ readonly provider: string; readonly modelId: string }>;
    readonly promptMessages: readonly HarnessModelMessage[];
    readonly request?: RequestPrefix;
    readonly requested?: boolean;
    readonly requestEnvelopeTokens: number | undefined;
    readonly size: number;
    readonly telemetryTurnId?: string;
  },
): Promise<HarnessModelMessage[] | undefined> {
  const { change, compaction } = input;
  const before = validateHarnessModelMessages(input.messages);
  const summaryUsage: (TokenUsageDelta | undefined)[] = [];
  let runOpen = false;
  const turnModel = once(input.turnModel);
  const requestOf = once(
    async (): Promise<RequestPrefix> =>
      input.request ?? (await requestPrefix(step, (await turnModel()).model)),
  );
  const executors = {
    summary: new Map<
      PublicAgentStaticModelDefinition | undefined,
      ReturnType<typeof modelExecutor>
    >(),
    turn: new Map<PublicAgentStaticModelDefinition | undefined, ReturnType<typeof modelExecutor>>(),
  };
  const executorFor = (
    which: PublicAgentStaticModelDefinition | undefined,
    kind: "summary" | "turn",
  ) => {
    const known =
      executors[kind].get(which) ?? modelExecutor(step, { ...input, turnModel }, which, kind);
    executors[kind].set(which, known);
    return known;
  };
  const openRun = async (modelId: string) => {
    if (runOpen) return;
    runOpen = true;
    await step.publish(
      startSummaryRun({ changeId: change.changeId, modelId, runId: change.runId }),
    );
  };
  const call = async (request: CompactionCallRequest): Promise<CompactionCallResult> => {
    await change.open();
    const inherits = request.tools === "inherit";
    const executor = await executorFor(request.model, inherits ? "turn" : "summary");
    await openRun(executor.modelId);
    const prefix = inherits || request.system === undefined ? await requestOf() : undefined;
    let called: Awaited<ReturnType<typeof executor.run>>;
    try {
      called = await executor.run({
        messages: await hydrateSandboxAttachments(request.messages as HarnessModelMessage[]),
        providerOptions: request.providerOptions,
        system: request.system === undefined ? prefix?.instructions : request.system || undefined,
        tools: inherits ? prefix?.tools : undefined,
      });
    } catch (error) {
      if (isContextOverflowError(error)) throw new CompactionOverflowError({ cause: error });
      throw error;
    }
    summaryUsage.push(called.usage);
    return {
      messages: validateHarnessModelMessages(called.messages) as StoredHistoryMessage[],
      text: called.text,
    };
  };
  const strategy = strategyOf(step);
  const fixedTokens = fixedPartTokens(input);
  const strategyAt = (
    run: Pick<Parameters<typeof strategyHistory>[1], "call" | "overflow" | "requested">,
  ) =>
    strategyHistory(strategy, {
      abortSignal: step.config.abortSignal ?? new AbortController().signal,
      estimateRatio: estimateRatio(compaction),
      fixedTokens,
      identity: input.identity ?? (async () => modelIdentity((await turnModel()).model)),
      model: {
        ...(compaction.contextWindowTokens !== undefined && {
          contextWindowTokens: compaction.contextWindowTokens,
        }),
        ...(stepReference(step).maxOutputTokens !== undefined && {
          maxOutputTokens: stepReference(step).maxOutputTokens,
        }),
      },
      recompacting: compaction.recentRewrite === true,
      sessionId: step.session.sessionId,
      ...run,
    });
  const history = strategyAt({
    call,
    overflow: input.overflow === true,
    requested: input.requested === true,
  });
  const again = strategyAt({
    call: () => {
      throw new Error("The compaction strategy compacts what it already returned.");
    },
    overflow: false,
    requested: false,
  });

  let messages: HarnessModelMessage[];
  try {
    const kept = await history({ history: before, tokens: input.size });
    if (kept === undefined || isDeepStrictEqual(kept, before)) {
      if (input.overflow === true) {
        throw new CompactionOverLimitError(
          "The model rejected the request as longer than its context window, and the compaction strategy kept the history as it was.",
        );
      }
      if (change.opened) await settleChange(step, { ...input, runOpen, summaryUsage }, before);
      return undefined;
    }
    await change.open();
    messages = checkHistory(before, kept, { limit: fitLimit(input) });
    await assertFixpoint(messages, again, input);
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
  step.session = { ...rewritten, compaction: { ...rewritten.compaction, recentRewrite: true } };
  return messages;
}

function once<T>(produce: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= produce());
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
  again: (input: {
    readonly history: readonly HarnessModelMessage[];
    readonly tokens: number;
  }) => Promise<readonly HarnessModelMessage[] | undefined>,
  input: { readonly requestEnvelopeTokens: number | undefined },
): Promise<void> {
  if (!checksSessionEvents()) return;
  const kept = await again({
    history,
    tokens: estimateTokens(history) + (input.requestEnvelopeTokens ?? 0),
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

function fixedPartTokens(input: {
  readonly messages: readonly HarnessModelMessage[];
  readonly promptMessages: readonly HarnessModelMessage[];
  readonly requestEnvelopeTokens: number | undefined;
}): number {
  const protectedTokens = Math.max(
    0,
    estimateTokens(input.promptMessages) - estimateTokens(input.messages),
  );
  return (input.requestEnvelopeTokens ?? 0) + protectedTokens;
}

async function compactionModel(
  step: Step,
  reference: RuntimeModelReference,
): Promise<CredentialedModel> {
  const resolved = await step.config.resolveModel(reference);
  return await credentialedModel(resolved);
}

interface ModelRequest {
  readonly messages: ModelMessage[];
  readonly system: RequestInstructions;
  readonly tools?: ToolSet;
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

async function modelExecutor(
  step: Step,
  input: {
    readonly change: { readonly runId: string };
    readonly turnModel: () => Promise<CredentialedModel>;
    readonly telemetryTurnId?: string;
  },
  which: PublicAgentStaticModelDefinition | undefined,
  kind: "summary" | "turn",
): Promise<{
  readonly modelId: string;
  run(prompt: ModelRequest): ReturnType<typeof streamCompactionCall>;
}> {
  const { config, session } = step;
  const turnReference = stepReference(step);
  const reference: RuntimeModelReference | undefined =
    typeof which === "string"
      ? { id: which }
      : which !== undefined
        ? undefined
        : kind === "turn"
          ? turnReference
          : (agentSettings(step).compactionModel ?? turnReference);
  const { model, renew } =
    which !== undefined && typeof which !== "string"
      ? { model: which as LanguageModel, renew: undefined }
      : reference === turnReference
        ? await input.turnModel()
        : await compactionModel(step, reference!);
  const profile = resolveModelProfile(model);
  const readsRecord = readsOpenAICompaction(modelIdentity(model));
  const attempt = step.instrumentation?.prepareAttempt({
    attempt: 0,
    runId: input.change.runId,
    runtimeContext: { "eve.compaction.request": kind },
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
      providerOptions: (which !== undefined ? turnReference : reference)?.providerOptions,
      session,
    }) as Parameters<typeof streamText>[0]["providerOptions"],
    onLanguageModelCallEnd: attempt?.onLanguageModelCallEnd,
    telemetry: attempt?.telemetry,
  };
  const retryScope = { sessionId: session.sessionId, turnId: step.position().turnId };
  const run = async (prompt: ModelRequest) => {
    const { providerOptions, tools, ...rest } = prompt;
    for (;;) {
      try {
        return await runModelCallWithRetries(
          () =>
            streamCompactionCall({
              ...call,
              ...rest,
              ...(!readsRecord && { messages: withoutOpenAICompaction(rest.messages) }),
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
  return { modelId: gatewayModelId(model) ?? "unknown", run };
}

function mergeProviderOptions(
  base: Parameters<typeof streamText>[0]["providerOptions"],
  extra: ModelRequest["providerOptions"],
): Parameters<typeof streamText>[0]["providerOptions"] {
  if (extra === undefined) return base;
  const merged: Record<string, Record<string, unknown>> = { ...base };
  for (const [provider, options] of Object.entries(extra)) {
    merged[provider] = { ...merged[provider], ...options };
  }
  const allowed = narrowedGatewayOnly(base?.gateway?.only, extra.gateway?.only);
  if (allowed !== undefined) merged.gateway = { ...merged.gateway, only: allowed };
  return merged as Parameters<typeof streamText>[0]["providerOptions"];
}

function narrowedGatewayOnly(configured: unknown, requested: unknown): unknown[] | undefined {
  if (!Array.isArray(configured) || !Array.isArray(requested)) return undefined;
  const allowed = requested.filter((provider) => configured.includes(provider));
  if (allowed.length === 0) {
    throw new Error(
      `The compaction request needs AI Gateway provider ${requested.join(", ")}, which this agent's gateway.only (${configured.join(", ")}) excludes, so eve did not send the history.`,
    );
  }
  return allowed;
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

async function streamCompactionCall(
  input: Omit<ModelRequest, "providerOptions" | "tools"> &
    Pick<
      Parameters<typeof streamText>[0],
      | "abortSignal"
      | "headers"
      | "model"
      | "onLanguageModelCallEnd"
      | "providerOptions"
      | "telemetry"
      | "tools"
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
