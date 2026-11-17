import { createLogger } from "#internal/logging.js";
import { contextScopeValue, withContextScopeValue } from "#context/container.js";
import { usageOf } from "#harness/facts.js";
import { recordUsage as recordUsageFact } from "#harness/session-machine/runs.js";
import type { Usage } from "#protocol/session-events/envelope.js";
import type { Publish } from "#harness/session-machine/commit.js";

interface UsageSink {
  readonly publish: Publish;
  readonly pending: Promise<unknown>[];
  readonly callId?: string;
  readonly inEffect?: true;
}

const SINK = Symbol.for("eve.usageSink");

const log = createLogger("harness.usage-sink");

export async function withUsageSink<T>(publish: Publish, fn: () => Promise<T>): Promise<T> {
  const pending: Promise<unknown>[] = [];
  const result = await withContextScopeValue(SINK, { pending, publish } satisfies UsageSink, fn);
  await Promise.all(pending);
  return result;
}

export function withUsageCall<T>(callId: string, fn: () => T): T {
  const sink = contextScopeValue<UsageSink>(SINK);
  return sink === undefined ? fn() : withContextScopeValue(SINK, { ...sink, callId }, fn);
}

export function withUsageInEffect<T>(fn: () => T): T {
  const sink = contextScopeValue<UsageSink>(SINK);
  if (sink === undefined) return fn();
  const { callId: _callId, ...rest } = sink;
  return withContextScopeValue(SINK, { ...rest, inEffect: true }, fn);
}

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
