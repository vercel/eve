/**
 * Span-level detail rendering and trace-level usage aggregation for
 * `eve traces`. Kept separate from the command module: the tree renderer
 * stays compact while these helpers answer "what does this span carry" —
 * inline metric chips for tree rows, the `--verbose` per-span block, and
 * the usage/cost totals summarized in the trace header.
 */

import { formatCompactTokenCount } from "#cli/dev/tui/stream-format.js";
import { formatAttributeContent } from "#cli/dev/tui/traces/trace-content.js";
import { formatElapsed } from "#cli/format-elapsed.js";
import { sanitizeForTerminal } from "#cli/ui/output.js";
import type { LocalTraceSpan } from "#tracing/local-trace-reader.js";

/** Usage and cost totals aggregated over a trace's `agent.step` spans. */
export interface LocalTraceSummary {
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Total gateway cost in USD; undefined when no span reported cost. */
  readonly costUsd?: number;
  readonly errorCount: number;
  readonly inputTokens: number;
  /** Distinct model ids seen on any span, first-seen order. */
  readonly models: readonly string[];
  readonly outputTokens: number;
}

/**
 * Compact metrics for one tree row: token chips (`↑1.4K`/`↓213`), cost
 * (`$0.0031`), and the tool name for `ai.toolCall` spans. Only chips whose
 * attributes the span actually carries — rows without usage stay clean.
 * Raw values: callers sanitize for their output surface.
 */
export function spanMetricChips(span: LocalTraceSpan): string[] {
  const chips: string[] = [];
  const input = numberAttribute(span, "agent.usage.input_tokens");
  const output = numberAttribute(span, "agent.usage.output_tokens");
  if (input !== undefined) chips.push(`↑${formatCompactTokenCount(input)}`);
  if (output !== undefined) chips.push(`↓${formatCompactTokenCount(output)}`);
  const cost = spanCostUsd(span);
  if (cost !== undefined) chips.push(formatCostUsd(cost));
  if (span.name === "ai.toolCall") {
    const tool = span.attributes["gen_ai.tool.name"];
    if (typeof tool === "string" && tool.length > 0) chips.push(tool);
  }
  return chips;
}

/**
 * Aggregates usage, cost, models, and errors across one trace. Only
 * `agent.step` spans contribute usage: model spans carry the same counters
 * and a subagent's totals already appear as its own step spans in the same
 * trace, so summing anything else would double-count.
 */
export function summarizeLocalTrace(spans: readonly LocalTraceSpan[]): LocalTraceSummary {
  const models: string[] = [];
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd: number | undefined;
  let errorCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const span of spans) {
    const model =
      stringAttribute(span, "agent.model.id") ?? stringAttribute(span, "gen_ai.request.model");
    if (model !== undefined && !models.includes(model)) models.push(model);
    if (span.statusCode === 2) errorCount += 1;
    if (span.name !== "agent.step") continue;
    inputTokens += numberAttribute(span, "agent.usage.input_tokens") ?? 0;
    outputTokens += numberAttribute(span, "agent.usage.output_tokens") ?? 0;
    cacheReadTokens += numberAttribute(span, "gen_ai.usage.cache_read.input_tokens") ?? 0;
    cacheWriteTokens += numberAttribute(span, "gen_ai.usage.cache_creation.input_tokens") ?? 0;
    const cost = spanCostUsd(span);
    if (cost !== undefined) costUsd = (costUsd ?? 0) + cost;
  }
  return {
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    errorCount,
    inputTokens,
    models,
    outputTokens,
  };
}

/** One-line `Tokens` header value: `↑1.2K in · ↓340 out · 1.1K cached`. */
export function formatTokenSummary(summary: LocalTraceSummary): string {
  const parts = [
    `↑${formatCompactTokenCount(summary.inputTokens)} in`,
    `↓${formatCompactTokenCount(summary.outputTokens)} out`,
  ];
  if (summary.cacheReadTokens > 0)
    parts.push(`${formatCompactTokenCount(summary.cacheReadTokens)} cached`);
  if (summary.cacheWriteTokens > 0)
    parts.push(`${formatCompactTokenCount(summary.cacheWriteTokens)} cache write`);
  return parts.join(" · ");
}

/** Formats a USD cost: `$1.50` at scale, `$0.0031` for typical spans. */
export function formatCostUsd(costUsd: number): string {
  return costUsd >= 1 ? `$${costUsd.toFixed(2)}` : `$${costUsd.toFixed(4)}`;
}

/**
 * The `--verbose` block for one span: facts (status, timing, ids), every
 * attribute sorted with payloads rendered as transcripts/pretty JSON, then
 * every event with its offset from span start, rendered as `tree(1)`-style
 * entries: each fact, attribute key, and event is an entry with a connector
 * beneath the span's row, so the rails never break. Payload content wraps
 * under its key on a plain margin. `childrenFollow` decides whether the last
 * entry closes the branch — child span rows come after the detail entries.
 */
export function renderSpanDetailTree(
  span: LocalTraceSpan,
  options: {
    readonly childrenFollow: boolean;
    readonly margin: string;
    readonly mute: (text: string) => string;
    readonly width: number;
  },
): string[] {
  const entries = spanDetailEntries(span, options.width - options.margin.length - 3);
  const lines: string[] = [];
  entries.forEach((entry, index) => {
    const last = index === entries.length - 1 && !options.childrenFollow;
    emit(entry, options.margin, last ? "└─ " : "├─ ");
  });
  return lines;

  function emit(entry: SpanDetailEntry, margin: string, connector: string): void {
    lines.push(options.mute(`${margin}${connector}${entry.head}`));
    const childMargin = `${margin}${connector === "└─ " ? "   " : "│  "}`;
    for (const line of entry.lines) lines.push(options.mute(`${childMargin}  ${line}`));
    entry.entries.forEach((nested, index) => {
      emit(nested, childMargin, index === entry.entries.length - 1 ? "└─ " : "├─ ");
    });
  }
}

/** One entry in a span's detail block: a head line plus nested content. */
interface SpanDetailEntry {
  readonly head: string;
  /** Payload content, rendered on a plain margin under the head. */
  readonly lines: readonly string[];
  /** Structural sub-entries (span events), rendered with connectors. */
  readonly entries: readonly SpanDetailEntry[];
}

function spanDetailEntries(span: LocalTraceSpan, width: number): SpanDetailEntry[] {
  // Payload formatting takes a dim style for de-emphasized parts; detail
  // lines are dimmed wholesale at emit time, so payloads get the identity.
  const dim = (text: string): string => text;
  const attrWidth = Math.max(40, width);
  const entries: SpanDetailEntry[] = [];
  const push = (
    head: string,
    lines: readonly string[] = [],
    nested: readonly SpanDetailEntry[] = [],
  ): void => {
    entries.push({ entries: nested, head, lines });
  };
  const error = span.statusCode === 2;
  const status =
    error && span.statusMessage !== undefined
      ? `ERROR — ${sanitizeForTerminal(span.statusMessage)}`
      : error
        ? "ERROR"
        : "ok";
  push(`status: ${status}`);
  push(`duration: ${formatElapsed(durationMs(span.startTimeNs, span.endTimeNs))}`);
  push(`started: ${new Date(Number(span.startTimeNs / 1_000_000n)).toISOString()}`);
  push(`span: ${span.spanId}`);
  if (span.parentSpanId !== undefined) push(`parent: ${span.parentSpanId}`);
  if (span.scope !== undefined) push(`scope: ${sanitizeForTerminal(span.scope)}`);
  if (span.kind !== undefined && span.kind !== 1) push(`kind: ${spanKind(span.kind)}`);

  for (const key of Object.keys(span.attributes).sort()) {
    const block = formatAttributeContent(key, span.attributes[key], dim, attrWidth - 2);
    const cleanKey = sanitizeForTerminal(key);
    if (block.length === 1) {
      push(`${cleanKey}: ${block[0]}`);
    } else {
      push(`${cleanKey}:`, block);
    }
  }

  if (span.events.length > 0) {
    push(
      "events:",
      [],
      span.events.map((event) => {
        const offsetMs = Math.max(0, durationMs(span.startTimeNs, event.timeNs));
        const lines: string[] = [];
        for (const key of Object.keys(event.attributes).sort()) {
          const block = formatAttributeContent(key, event.attributes[key], dim, attrWidth - 6);
          const cleanKey = sanitizeForTerminal(key);
          if (block.length === 1) {
            lines.push(`${cleanKey}: ${block[0]}`);
          } else {
            lines.push(`${cleanKey}:`, ...block.map((line) => `  ${line}`));
          }
        }
        return {
          entries: [],
          head: `${sanitizeForTerminal(event.name)}  +${formatElapsed(offsetMs)}`,
          lines,
        };
      }),
    );
  }
  return entries;
}

function spanCostUsd(span: LocalTraceSpan): number | undefined {
  return (
    numberAttribute(span, "gen_ai.usage.gateway_cost") ?? numberAttribute(span, "gen_ai.usage.cost")
  );
}

function spanKind(kind: number): string {
  switch (kind) {
    case 2:
      return "server";
    case 3:
      return "client";
    case 4:
      return "producer";
    case 5:
      return "consumer";
    default:
      return `unknown (${kind})`;
  }
}

function numberAttribute(span: LocalTraceSpan, key: string): number | undefined {
  const value = span.attributes[key];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringAttribute(span: LocalTraceSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function durationMs(start: bigint, end: bigint): number {
  return Number(end - start) / 1_000_000;
}
