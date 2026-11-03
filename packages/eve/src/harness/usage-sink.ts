import { createLogger } from "#internal/logging.js";
import { contextScopeValue, withContextScopeValue } from "#context/container.js";
import { usageOf } from "#harness/facts.js";
import { recordUsage as recordUsageFact } from "#harness/session-machine/runs.js";
import type { Usage } from "#protocol/session-events/envelope.js";
import type { Publish } from "#harness/session-machine/commit.js";

/** Where usage a step's own code spends goes: the step's events, against the running call. */
interface UsageSink {
  readonly publish: Publish;
  /** What was published without waiting, which the step waits for before it returns. */
  readonly pending: Promise<unknown>[];
  readonly callId?: string;
  /**
   * Set inside a reaction, such as a hook: its publish waits for the reactions queued behind the
   * one running, so recording doesn't wait for it.
   */
  readonly inEffect?: true;
}

const SINK = Symbol.for("eve.usageSink");

const log = createLogger("harness.usage-sink");

/**
 * Runs `fn` with usage it records published as the step's. Usage a hook recorded without waiting
 * is written before the step returns, so its usage report counts it.
 */
export async function withUsageSink<T>(publish: Publish, fn: () => Promise<T>): Promise<T> {
  const pending: Promise<unknown>[] = [];
  const result = await withContextScopeValue(SINK, { pending, publish } satisfies UsageSink, fn);
  await Promise.all(pending);
  return result;
}

/** Runs a tool's `fn` with usage it records owned by its call. */
export function withUsageCall<T>(callId: string, fn: () => T): T {
  const sink = contextScopeValue<UsageSink>(SINK);
  return sink === undefined ? fn() : withContextScopeValue(SINK, { ...sink, callId }, fn);
}

/**
 * Runs a reaction's `fn`, where usage it records is published without waiting on reactions. A
 * reaction can start inside a tool's call, from its progress, but what it spends isn't the call's.
 */
export function withUsageInEffect<T>(fn: () => T): T {
  const sink = contextScopeValue<UsageSink>(SINK);
  if (sink === undefined) return fn();
  const { callId: _callId, ...rest } = sink;
  return withContextScopeValue(SINK, { ...rest, inEffect: true }, fn);
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
    recordUsageFact({ callId: sink.callId, kind: options.kind ?? "auxiliary", usage: counted }),
  );
  if (sink.inEffect !== true) return await published;
  sink.pending.push(
    published.catch((error: unknown) => log.error("recording usage failed", { error })),
  );
}
