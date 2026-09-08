import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";
import { isAgentActivationSpan } from "#tracing/agent-span-contract.js";

const REMEMBERED_TRACE_LIMIT = 2048;

interface SpanLike {
  readonly name?: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly instrumentationScope?: { readonly name?: string };
  readonly spanContext: () => { readonly traceId: string };
}

/** Routes spans from agent-owned traces to provider-neutral child processors. */
export class AgentTraceSpanProcessor implements SpanProcessor {
  readonly #children: readonly SpanProcessor[];
  readonly #ownedTraceIds = new Set<string>();
  readonly #completedTraceIds = new Set<string>();
  readonly #rememberedTraceIds = new Set<string>();
  readonly #traceOwners = new Map<string, string>();
  constructor(children: readonly SpanProcessor[]) {
    this.#children = children;
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.#children.map((child) => child.forceFlush()));
  }

  onStart(span: unknown, parentContext: unknown): void {
    if (!isSpanLike(span)) return;
    const sessionId = span.attributes["agent.session.id"];
    if (typeof sessionId === "string") {
      const traceId = span.spanContext().traceId;
      const known = this.#ownedTraceIds.has(traceId) || this.#rememberedTraceIds.has(traceId);
      if (!known) {
        this.#ownedTraceIds.add(traceId);
        this.#traceOwners.set(traceId, sessionId);
      }
    }
    if (!this.#accepts(span)) return;
    for (const child of this.#children) child.onStart(span, parentContext);
  }

  onEnd(span: unknown): void {
    if (!isSpanLike(span) || !this.#accepts(span)) return;
    for (const child of this.#children) child.onEnd(span);
    const traceId = span.spanContext().traceId;
    if (
      isAgentActivationSpan({ name: span.name ?? "", attributes: span.attributes }) &&
      this.#traceOwners.get(traceId) === span.attributes["agent.session.id"]
    ) {
      this.#completedTraceIds.add(traceId);
    }
  }

  /** Trace IDs protected by an unfinished activation or pending final writes. */
  activeTraceIds(): ReadonlySet<string> {
    return this.#ownedTraceIds;
  }

  /** Called only after writes drain; recently completed IDs still accept late descendants. */
  releaseCompletedTraces(): boolean {
    if (this.#completedTraceIds.size === 0) return false;
    for (const traceId of this.#completedTraceIds) {
      this.#ownedTraceIds.delete(traceId);
      this.#traceOwners.delete(traceId);
      this.#rememberedTraceIds.add(traceId);
    }
    this.#completedTraceIds.clear();
    while (this.#rememberedTraceIds.size > REMEMBERED_TRACE_LIMIT) {
      const oldest = this.#rememberedTraceIds.values().next().value!;
      this.#rememberedTraceIds.delete(oldest);
    }
    return true;
  }

  /** Releases only traces owned by this session. */
  releaseSession(sessionId: string): boolean {
    let released = false;
    for (const [traceId, owner] of this.#traceOwners) {
      if (owner !== sessionId) continue;
      released = true;
      this.#ownedTraceIds.delete(traceId);
      this.#completedTraceIds.delete(traceId);
      this.#traceOwners.delete(traceId);
    }
    return released;
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.#children.map((child) => child.shutdown()));
  }

  #accepts(span: SpanLike): boolean {
    return (
      span.instrumentationScope?.name !== "workflow" &&
      (this.#ownedTraceIds.has(span.spanContext().traceId) ||
        this.#rememberedTraceIds.has(span.spanContext().traceId))
    );
  }
}

function isSpanLike(value: unknown): value is SpanLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "attributes" in value &&
    "spanContext" in value &&
    typeof value.spanContext === "function"
  );
}
