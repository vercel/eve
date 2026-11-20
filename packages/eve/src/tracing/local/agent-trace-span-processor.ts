import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";
import { isAgentActivationSpan, isDirectToolCallSpan } from "#tracing/local/inspection.js";

const REMEMBERED_TRACE_LIMIT = 2048;

interface SpanLike {
  readonly name?: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly instrumentationScope?: { readonly name?: string };
  readonly spanContext: () => { readonly spanId?: string; readonly traceId: string };
}

export class AgentTraceSpanProcessor implements SpanProcessor {
  readonly #children: readonly SpanProcessor[];
  readonly #ownedTraceIds = new Set<string>();
  readonly #completedTraceIds = new Set<string>();
  readonly #rememberedTraceIds = new Set<string>();
  readonly #directCalls = new Map<string, Set<string>>();
  readonly #traceOwnership = new Map<
    string,
    { readonly conversationId: string; readonly ownerRunId?: string }
  >();
  constructor(children: readonly SpanProcessor[]) {
    this.#children = children;
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.#children.map((child) => child.forceFlush()));
  }

  onStart(span: unknown, parentContext: unknown): void {
    if (!isSpanLike(span)) return;
    if (isDirectToolCallSpan(span)) this.#startDirectCall(span);
    const conversationId = span.attributes["gen_ai.conversation.id"];
    const runId = span.attributes["agent.run.id"];
    if (typeof conversationId === "string") {
      const traceId = span.spanContext().traceId;
      const known = this.#ownedTraceIds.has(traceId) || this.#rememberedTraceIds.has(traceId);
      if (!known) {
        this.#ownedTraceIds.add(traceId);
        this.#traceOwnership.set(traceId, {
          conversationId,
          ownerRunId: typeof runId === "string" ? runId : undefined,
        });
      } else if (
        this.#traceOwnership.get(traceId)?.ownerRunId === undefined &&
        typeof runId === "string"
      ) {
        this.#traceOwnership.set(traceId, { conversationId, ownerRunId: runId });
      }
    }
    if (!this.#accepts(span)) return;
    for (const child of this.#children) child.onStart(span, parentContext);
  }

  onEnd(span: unknown): void {
    if (!isSpanLike(span) || !this.#accepts(span)) return;
    for (const child of this.#children) child.onEnd(span);
    const traceId = span.spanContext().traceId;
    const ownership = this.#traceOwnership.get(traceId);
    if (
      isAgentActivationSpan({ name: span.name ?? "", attributes: span.attributes }) &&
      ownership?.ownerRunId === span.attributes["agent.run.id"] &&
      ownership?.conversationId === span.attributes["gen_ai.conversation.id"]
    ) {
      this.#completedTraceIds.add(traceId);
    }
    if (isDirectToolCallSpan(span)) this.#endDirectCall(span);
  }

  activeTraceIds(): ReadonlySet<string> {
    return this.#ownedTraceIds;
  }

  releaseCompletedTraces(): boolean {
    if (this.#completedTraceIds.size === 0) return false;
    for (const traceId of this.#completedTraceIds) {
      this.#ownedTraceIds.delete(traceId);
      this.#traceOwnership.delete(traceId);
      this.#rememberedTraceIds.add(traceId);
    }
    this.#completedTraceIds.clear();
    while (this.#rememberedTraceIds.size > REMEMBERED_TRACE_LIMIT) {
      const oldest = this.#rememberedTraceIds.values().next().value!;
      this.#rememberedTraceIds.delete(oldest);
    }
    return true;
  }

  releaseConversation(conversationId: string): boolean {
    let released = false;
    for (const [traceId, ownership] of this.#traceOwnership) {
      if (ownership.conversationId !== conversationId) continue;
      released = true;
      this.#ownedTraceIds.delete(traceId);
      this.#completedTraceIds.delete(traceId);
      this.#traceOwnership.delete(traceId);
      this.#directCalls.delete(traceId);
    }
    return released;
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.#children.map((child) => child.shutdown()));
  }

  #startDirectCall(span: SpanLike): void {
    const { spanId, traceId } = span.spanContext();
    if (spanId === undefined) return;
    const open = this.#directCalls.get(traceId);
    if (open !== undefined) {
      open.add(spanId);
      this.#completedTraceIds.delete(traceId);
      return;
    }
    if (this.#ownedTraceIds.has(traceId) && !this.#completedTraceIds.has(traceId)) return;
    const conversationId = span.attributes["gen_ai.conversation.id"];
    const runId = span.attributes["agent.run.id"];
    if (typeof conversationId !== "string") return;
    this.#completedTraceIds.delete(traceId);
    this.#rememberedTraceIds.delete(traceId);
    this.#ownedTraceIds.add(traceId);
    this.#traceOwnership.set(traceId, {
      conversationId,
      ownerRunId: typeof runId === "string" ? runId : undefined,
    });
    this.#directCalls.set(traceId, new Set([spanId]));
  }

  #endDirectCall(span: SpanLike): void {
    const { spanId, traceId } = span.spanContext();
    const open = this.#directCalls.get(traceId);
    if (spanId === undefined || open === undefined || !open.delete(spanId)) return;
    if (open.size > 0) return;
    this.#directCalls.delete(traceId);
    this.#completedTraceIds.add(traceId);
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
