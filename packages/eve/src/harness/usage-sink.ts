import { createLogger } from "#internal/logging.js";
import { contextScopeValue, withContextScopeValue } from "#context/container.js";
import { fact, usageOf } from "#harness/facts.js";
import type { Usage } from "#protocol/session-events/envelope.js";
import type { Publish } from "#harness/session-machine/commit.js";

/** Where usage a step's own code spends goes: the step's events, against the running call. */
interface UsageSink {
  readonly publish: Publish;
  readonly callId?: string;
  /**
   * Set inside a reaction, such as a hook: its publish waits for the reactions queued behind the
   * one running, so recording doesn't wait for it.
   */
  readonly inReaction?: true;
}

const SINK = Symbol.for("eve.usageSink");

const log = createLogger("harness.usage-sink");

/** Runs `fn` with usage it records published as the step's. */
export function withUsageSink<T>(publish: Publish, fn: () => T): T {
  return withContextScopeValue(SINK, { publish } satisfies UsageSink, fn);
}

/** Runs a tool's `fn` with usage it records owned by its call. */
export function withUsageCall<T>(callId: string, fn: () => T): T {
  const sink = contextScopeValue<UsageSink>(SINK);
  return sink === undefined ? fn() : withContextScopeValue(SINK, { ...sink, callId }, fn);
}

/** Runs a reaction's `fn`, where usage it records is published without waiting on reactions. */
export function withUsageInReaction<T>(fn: () => T): T {
  const sink = contextScopeValue<UsageSink>(SINK);
  return sink === undefined ? fn() : withContextScopeValue(SINK, { ...sink, inReaction: true }, fn);
}

/**
 * Records what a model call made outside eve's own model steps spent, so the session's usage and
 * its limits count it: inside a tool, against its call. Outside a session step it does nothing.
 */
export async function recordUsage(
  usage: Partial<Usage>,
  options: { readonly kind?: "auxiliary" | "decision" } = {},
): Promise<void> {
  const sink = contextScopeValue<UsageSink>(SINK);
  if (sink === undefined) return;
  const counted = usageOf(usage);
  const published = sink.publish(
    fact("usage.recorded", {
      kind: options.kind ?? "auxiliary",
      ...(sink.callId !== undefined && { owner: { callId: sink.callId } }),
      usage: counted,
    }),
  );
  if (sink.inReaction !== true) return await published;
  published.catch((error: unknown) => log.error("recording usage failed", { error }));
}
