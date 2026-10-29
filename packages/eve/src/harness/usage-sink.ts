import { contextScopeValue, withContextScopeValue } from "#context/container.js";
import { fact, usageOf } from "#harness/facts.js";
import type { Publish } from "#harness/session-machine/commit.js";

/** Where usage a step's own code spends goes: the step's events, against the running call. */
interface UsageSink {
  readonly publish: Publish;
  readonly callId?: string;
}

const SINK = Symbol.for("eve.usageSink");

/** Runs `fn` with usage it records published as the step's. */
export function withUsageSink<T>(publish: Publish, fn: () => T): T {
  return withContextScopeValue(SINK, { publish } satisfies UsageSink, fn);
}

/** Runs a tool's `fn` with usage it records owned by its call. */
export function withUsageCall<T>(callId: string, fn: () => T): T {
  const sink = contextScopeValue<UsageSink>(SINK);
  return sink === undefined ? fn() : withContextScopeValue(SINK, { ...sink, callId }, fn);
}

/** Tokens and cost, as the AI SDK reports a call's usage, or as eve's usage counts them. */
export interface RecordedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly inputTokenDetails?: {
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
  readonly costUsd?: number;
}

/**
 * Records what a model call made outside eve's own model steps spent, so the session's usage and
 * its limits count it: inside a tool, against its call. Outside a session step it does nothing.
 */
export async function recordUsage(
  usage: RecordedUsage,
  options: { readonly kind?: string } = {},
): Promise<void> {
  const sink = contextScopeValue<UsageSink>(SINK);
  if (sink === undefined) return;
  const counted = usageOf({
    cacheReadTokens: usage.cacheReadTokens ?? usage.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens ?? usage.inputTokenDetails?.cacheWriteTokens,
    costUsd: usage.costUsd,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
  await sink.publish(
    fact("usage.recorded", {
      kind: options.kind ?? "auxiliary",
      ...(sink.callId !== undefined && { owner: { callId: sink.callId } }),
      usage: counted,
    }),
  );
}
