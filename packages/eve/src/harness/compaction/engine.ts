import type { ModelMessage } from "ai";

import { estimateTokens } from "#harness/token-estimate.js";
import type { CompactionState, PromptMeasurement } from "#harness/types.js";

const DEFAULT_ESTIMATE_RATIO = 1.6;

export function estimateRatio(config: CompactionState): number {
  return config.estimateRatio ?? DEFAULT_ESTIMATE_RATIO;
}

export function getInputTokenCount(
  messages: readonly ModelMessage[],
  config: CompactionState,
  requestEnvelopeTokens = 0,
  previousEnvelopeTokens = 0,
): number {
  const prior = config.lastKnownInputTokens;
  const priorCount = config.lastKnownPromptMessageCount;
  const scale =
    config.estimateRatio !== undefined &&
    Number.isFinite(config.estimateRatio) &&
    config.estimateRatio > 1
      ? Math.min(DEFAULT_ESTIMATE_RATIO, config.estimateRatio)
      : 1;

  if (
    prior === undefined ||
    priorCount === undefined ||
    !Number.isInteger(priorCount) ||
    priorCount < 0 ||
    priorCount > messages.length
  ) {
    return Math.ceil((estimateTokens(messages) + requestEnvelopeTokens) * scale);
  }

  const appended = messages.slice(priorCount);
  return (
    prior +
    (appended.length === 0 ? 0 : Math.ceil(estimateTokens(appended) * scale)) +
    Math.max(0, requestEnvelopeTokens - previousEnvelopeTokens)
  );
}

export function withoutPromptMeasurement(config: CompactionState): CompactionState {
  const {
    lastKnownInputTokens: _input,
    lastKnownPromptMessageCount: _count,
    measurementsByModel: _byModel,
    ...rest
  } = config;
  return rest;
}

export function withPromptMeasurement(
  config: CompactionState,
  measured: {
    readonly promptMessages?: readonly ModelMessage[];
    readonly inputTokens?: number;
    readonly modelId: string;
    readonly promptMessageCount?: number;
    readonly requestEnvelopeTokens?: number;
  },
): CompactionState {
  const {
    recentRewrite,
    requestEnvelopeTokens: _envelope,
    ...next
  } = withoutPromptMeasurement(config);
  const { measurementsByModel } = config;
  if (measured.inputTokens === undefined || measured.promptMessageCount === undefined) {
    return measurementsByModel === undefined ? next : { ...next, measurementsByModel };
  }
  const { inputTokens } = measured;
  const estimatedTokens =
    measured.promptMessages === undefined
      ? undefined
      : estimateTokens(measured.promptMessages) + (measured.requestEnvelopeTokens ?? 0);
  const measurement: PromptMeasurement = {
    inputTokens: measured.inputTokens,
    promptMessageCount: measured.promptMessageCount,
    ...(measured.requestEnvelopeTokens !== undefined && {
      requestEnvelopeTokens: measured.requestEnvelopeTokens,
    }),
  };
  return {
    ...next,
    ...(recentRewrite === true && config.lastKnownInputTokens === undefined && { recentRewrite }),
    ...(estimatedTokens !== undefined &&
      estimatedTokens > 0 &&
      inputTokens > 0 && { estimateRatio: inputTokens / estimatedTokens }),
    lastKnownInputTokens: measurement.inputTokens,
    lastKnownPromptMessageCount: measurement.promptMessageCount,
    ...(measurement.requestEnvelopeTokens !== undefined && {
      requestEnvelopeTokens: measurement.requestEnvelopeTokens,
    }),
    measurementsByModel: { ...measurementsByModel, [measured.modelId]: measurement },
  };
}

export function withModelPromptMeasurement(
  config: CompactionState,
  modelId: string,
  prompt?: {
    readonly messages: readonly ModelMessage[];
    readonly requestEnvelopeTokens: number;
  },
): CompactionState {
  const own = config.measurementsByModel?.[modelId];
  if (own === undefined) return config;
  const { requestEnvelopeTokens: _envelope, ...rest } = config;
  const selected = {
    ...rest,
    lastKnownInputTokens: own.inputTokens,
    lastKnownPromptMessageCount: own.promptMessageCount,
    ...(own.requestEnvelopeTokens !== undefined && {
      requestEnvelopeTokens: own.requestEnvelopeTokens,
    }),
  };
  if (prompt !== undefined) {
    const ownTokens = getInputTokenCount(
      prompt.messages,
      selected,
      prompt.requestEnvelopeTokens,
      own.requestEnvelopeTokens,
    );
    const latestTokens = getInputTokenCount(
      prompt.messages,
      config,
      prompt.requestEnvelopeTokens,
      config.requestEnvelopeTokens,
    );
    if (latestTokens > ownTokens) return config;
  }
  return selected;
}
