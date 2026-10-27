import type { ModelMessage } from "ai";

import { estimateTokens } from "#harness/token-estimate.js";
import type { CompactionConfig } from "#harness/types.js";

/**
 * Best available input-token count: the model-reported count from the last
 * step, plus a rough character-based estimate of whatever messages have been
 * appended since.
 */
export function getInputTokenCount(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
  requestEnvelopeTokens = 0,
  previousEnvelopeTokens = 0,
): number {
  const prior = config.lastKnownInputTokens;
  const priorCount = config.lastKnownPromptMessageCount;

  if (
    prior === undefined ||
    priorCount === undefined ||
    !Number.isInteger(priorCount) ||
    priorCount < 0 ||
    priorCount > messages.length
  ) {
    return estimateTokens(messages) + requestEnvelopeTokens;
  }

  const appended = messages.slice(priorCount);
  return (
    prior +
    (appended.length === 0 ? 0 : estimateTokens(appended)) +
    Math.max(0, requestEnvelopeTokens - previousEnvelopeTokens)
  );
}

/** The settings without the last measured prompt, which a rewritten history no longer matches. */
export function withoutPromptMeasurement(config: CompactionConfig): CompactionConfig {
  const { lastKnownInputTokens: _input, lastKnownPromptMessageCount: _count, ...rest } = config;
  return rest;
}

/**
 * The settings with a model-reported prompt measurement and the envelope around it. Without a
 * usable measurement, the next count is an estimate, and no envelope baseline applies.
 */
export function withPromptMeasurement(
  config: CompactionConfig,
  measured: {
    readonly inputTokens?: number;
    readonly promptMessageCount?: number;
    readonly requestEnvelopeTokens?: number;
  },
): CompactionConfig {
  const { requestEnvelopeTokens: _envelope, ...next } = withoutPromptMeasurement(config);
  if (measured.inputTokens === undefined || measured.promptMessageCount === undefined) return next;
  return {
    ...next,
    lastKnownInputTokens: measured.inputTokens,
    lastKnownPromptMessageCount: measured.promptMessageCount,
    ...(measured.requestEnvelopeTokens !== undefined && {
      requestEnvelopeTokens: measured.requestEnvelopeTokens,
    }),
  };
}

/**
 * The overflow guard: true when the next request's input tokens pass the limit. The kernel
 * runs it before every model call, and no strategy can configure or turn it off.
 */
export function exceedsLimit(measured: {
  readonly inputTokens: number;
  readonly threshold: number;
}): boolean {
  return measured.inputTokens > measured.threshold;
}

/** The share of the context window a request may fill: the core's fixed overflow guard. */
const OVERFLOW_GUARD_RATIO = 0.9;

export function overflowThreshold(contextWindowTokens: number): number {
  return Math.max(1, Math.floor(contextWindowTokens * OVERFLOW_GUARD_RATIO));
}

const FALLBACK_COMPACTION_THRESHOLD = 100_000;

/** The input tokens a request may carry before the history compacts, for a model's window. */
export function compactionThreshold(contextWindowTokens?: number): number {
  return contextWindowTokens === undefined
    ? FALLBACK_COMPACTION_THRESHOLD
    : overflowThreshold(contextWindowTokens);
}
