import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

interface SpanLike {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly instrumentationScope?: { readonly name?: string };
  readonly spanContext: () => { readonly traceId: string };
}

/** Routes spans from agent-owned traces to provider-neutral child processors. */
export class AgentTraceSpanProcessor implements SpanProcessor {
  readonly #children: readonly SpanProcessor[];
  readonly #ownedTraceIds = new Set<string>();
  readonly #sessionTraceIds = new Map<string, Set<string>>();
  #attached = false;

  constructor(children: readonly SpanProcessor[]) {
    this.#children = children;
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.#children.map((child) => child.forceFlush()));
  }

  isAttached(): boolean {
    return this.#attached;
  }

  onStart(span: unknown, parentContext: unknown): void {
    this.#attached = true;
    if (!isSpanLike(span)) return;
    const sessionId = span.attributes["agent.session.id"];
    if (typeof sessionId === "string") {
      const rootSessionId = span.attributes["agent.root.session.id"];
      const owner = typeof rootSessionId === "string" ? rootSessionId : sessionId;
      const traceId = span.spanContext().traceId;
      this.#ownedTraceIds.add(traceId);
      const owned = this.#sessionTraceIds.get(owner) ?? new Set<string>();
      owned.add(traceId);
      this.#sessionTraceIds.set(owner, owned);
    }
    if (!this.#accepts(span)) return;
    for (const child of this.#children) child.onStart(span, parentContext);
  }

  onEnd(span: unknown): void {
    if (!isSpanLike(span) || !this.#accepts(span)) return;
    for (const child of this.#children) child.onEnd(span);
  }

  /** Trace ids whose session is still open, so retention never evicts them. */
  activeTraceIds(): ReadonlySet<string> {
    return this.#ownedTraceIds;
  }

  /**
   * Forgets every trace one root session owned, reporting whether it owned any.
   * A subagent child owns none, so releasing one reports `false` and leaves the
   * shared trace pinned until its root finishes.
   */
  releaseSession(sessionId: string): boolean {
    const owned = this.#sessionTraceIds.get(sessionId);
    if (owned === undefined) return false;
    for (const traceId of owned) this.#ownedTraceIds.delete(traceId);
    this.#sessionTraceIds.delete(sessionId);
    return true;
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.#children.map((child) => child.shutdown()));
  }

  #accepts(span: SpanLike): boolean {
    return (
      span.instrumentationScope?.name !== "workflow" &&
      this.#ownedTraceIds.has(span.spanContext().traceId)
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
